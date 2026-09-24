/**
 * ============================================================
 * CRYPTORIUM // SERVICES // RISK ENGINE & PRE-TRADE CONTROLS
 * Phase 3 Quantitative Pre-Trade Gatekeeper
 *
 * Invariants:
 *  1. Zero Bypass: All orders must pass validateOrder().
 *  2. Synchronous Gatekeeping: Completes synchronously in < 1ms.
 *  3. Fail-Closed: Missing or stale (> 5000ms) data causes immediate REJECTION.
 * ============================================================
 */

export class RiskEngine {
  /**
   * @param {Object|null} db - SQLite database instance (DatabaseSync, better-sqlite3, or custom adapter)
   * @param {Object|null} localStore - Cached state store providing balances, mark prices, and timestamps
   * @param {Object} [config={}] - Risk parameters overriding defaults
   */
  constructor(db = null, localStore = null, config = {}) {
    this.config = {
      maxRiskPerTradePct: 0.01,          // 1% max capital risk per trade
      maxLeverage: 2,                    // Strict leverage ceiling (default 2x conservative, configurable)
      maxDailyDrawdownPct: 0.03,         // -3% daily drawdown circuit breaker
      maxConsecutiveLosses: 3,           // 3 consecutive losses triggers cooldown
      consecutiveLossCooldownMs: 2 * 60 * 60 * 1000, // 2 hours cooldown (7,200,000 ms)
      minLiquidationDistancePct: 0.02,   // 2% minimum safe buffer to projected liquidation price
      maxOrdersPerSecond: 5,             // Rate limit: max 5 orders / sec
      maxOrdersPerMinute: 50,            // Rate limit: max 50 orders / min
      maxStalenessMs: 5000,              // Fail-closed threshold: 5000ms
      fixedStopLossPct: 0.008,           // Default 0.8% stop loss distance
      fixedTakeProfitPct: 0.018,         // 1.8% Take Profit (1.5% - 2.0% range to cover fees/slippage)
      trailingBreakEvenProfitTriggerPct: 0.012, // +1.2% unrealized profit triggers trailing break-even
      feeBufferPct: 0.0010,              // 0.10% round-trip taker fee buffer
      smallBalanceThresholdUsdt: 50.00,  // Small balance override threshold (<$50.00)
      minNotionalUsdt: 10.00,            // Fixed minimum trade size of $10.00 USDT for Binance MIN_NOTIONAL
      btcMinNotionalFloorUsdt: 50.00,    // Binance Futures BTCUSDT minimum notional floor (0.001 BTC step)
      smallBalanceAltcoinPair: 'XRPUSDT', // Lower-minimum altcoin pair ($5.00 min notional)
      smallBalanceThresholdForAltcoin: 10.00, // < 10 USDT triggers smart altcoin routing
      enableDynamicBtcLeverageBump: true, // Dynamically bump leverage on BTCUSDT to pass 50 USDT floor
      smallBalanceMaxBtcLeverage: 10,    // Max dynamic leverage for small balance BTCUSDT trades (up to 10x)
      maxPositionNotionalUsdt: 20.00,    // Conservative notional cap in USDT
      maxOpenPositions: 2,               // Maximum concurrent active positions
      maintenanceMarginRate: 0.004,      // 0.4% default MMR (Tier 1 BTC/ETH on Binance)
      ...config
    };

    this.localStore = localStore || this._createDefaultStore();
    this.db = this._initDatabase(db);

    // In-memory circuit breaker & rate limiting state
    this.tradingHalted = false;
    this.haltReason = null;
    this.haltedUntilUtcMidnight = false;
    this.currentUtcDay = this._getCurrentUtcDayString();
    this.cooldownUntil = 0;
    this.orderTimestamps = []; // Monotonic sliding window for frequency limiting

    // Cache of recent closed trades for synchronous < 1ms access
    this._recentClosedTrades = [];
    this._loadRecentTradesFromDb();

    // Setup DB schema if SQLite database provided
    this._setupSchema();
  }

  // ============================================================
  // PRIMARY ZERO-BYPASS ENTRY POINT
  // ============================================================

  /**
   * Synchronous zero-bypass gatekeeper for all order candidates.
   * Runs in < 1ms strictly in-memory without async I/O.
   *
   * @param {Object} candidate - Order parameters candidate
   * @param {string} candidate.symbol - e.g., 'BTCUSDT'
   * @param {'BUY'|'SELL'|'LONG'|'SHORT'} candidate.side - Order side
   * @param {'MARKET'|'LIMIT'} [candidate.type='MARKET'] - Order type
   * @param {number} [candidate.price] - Limit price or anticipated entry price
   * @param {number} [candidate.quantity] - Requested size in contracts / base units
   * @param {number} [candidate.notional] - Requested notional in USDT
   * @param {number} candidate.leverage - Requested leverage multiplier
   * @param {number} [candidate.stopLossPrice] - Projected stop loss price
   * @param {number} [candidate.takeProfitPrice] - Projected take profit price
   * @param {'ISOLATED'|'CROSS'} [candidate.marginType='ISOLATED'] - Margin type
   * @param {boolean} [candidate.reduceOnly=false] - Whether order is reduce-only
   * @returns {{
   *   approved: boolean,
   *   reason: string | null,
   *   adjustedQty: number | null,
   *   metadata?: Object
   * }}
   */
  validateOrder(candidate) {
    const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // 0. Roll over UTC day if midnight passed
    this._checkUtcDayRollover();

    // 1. Basic Structural Invariants
    if (!candidate || typeof candidate !== 'object') {
      return this._reject('Fail-closed: Order candidate payload is invalid or null');
    }

    const symbol = (candidate.symbol || '').toUpperCase().trim();
    if (!symbol) {
      return this._reject('Fail-closed: Missing contract symbol in order candidate');
    }

    const side = (candidate.side || '').toUpperCase().trim();
    if (!['BUY', 'SELL', 'LONG', 'SHORT'].includes(side)) {
      return this._reject(`Fail-closed: Invalid order side "${candidate.side}"`);
    }

    // 2. Consecutive Loss Cooldown Gate
    const now = Date.now();
    if (this.cooldownUntil > now) {
      const remainingSec = Math.ceil((this.cooldownUntil - now) / 1000);
      const remainingMin = Math.ceil(remainingSec / 60);
      return this._reject(`Consecutive loss cooldown active: ${remainingMin}m remaining (${remainingSec}s). Trading paused.`);
    }

    // 3. Global Circuit Breakers (Trading Halted)
    if (this.tradingHalted) {
      return this._reject(`Trading is HALTED: ${this.haltReason || 'Circuit breaker active'}`);
    }

    // 4. Rate Limiter (Max 5 orders/sec, Max 50 orders/min)
    const rateCheck = this._checkRateLimits(now);
    if (!rateCheck.allowed) {
      return this._reject(rateCheck.reason);
    }

    // 5. Fail-Closed Architecture: Check Staleness of Account Balance (< 5000ms)
    const balanceData = this._getBalanceData();
    if (!balanceData || balanceData.walletBalance <= 0) {
      return this._reject('Fail-closed: Account balance data is missing or zero');
    }
    const balanceAge = now - balanceData.timestamp;
    if (balanceAge > this.config.maxStalenessMs) {
      return this._reject(`Fail-closed: Account balance data is stale (${balanceAge}ms > ${this.config.maxStalenessMs}ms limit)`);
    }

    const unrealizedPnl = balanceData.unrealizedPnl || 0;
    const totalCapital = balanceData.walletBalance + unrealizedPnl;

    if (totalCapital <= 0) {
      return this._reject(`Fail-closed: Available capital is non-positive ($${totalCapital.toFixed(2)})`);
    }

    // 6. Smart Pair Routing for Small Balances (< 10 USDT)
    let effectiveSymbol = symbol;
    let routedToAltcoin = false;
    let routedReason = null;

    if (symbol === 'BTCUSDT' && totalCapital < (this.config.smallBalanceThresholdForAltcoin || 10.00)) {
      if (candidate.autoRouteAltcoin === true || candidate.allowAltcoinRouting === true) {
        const altcoin = this.config.smallBalanceAltcoinPair || 'XRPUSDT';
        const altMarkData = this._getMarkPriceData(altcoin);
        if (altMarkData && altMarkData.price > 0 && (now - altMarkData.timestamp <= this.config.maxStalenessMs)) {
          effectiveSymbol = altcoin;
          routedToAltcoin = true;
          routedReason = `Small balance ($${totalCapital.toFixed(2)} USDT < $10.00) routed from BTCUSDT to ${altcoin} to satisfy lower exchange notional requirements ($5.00 vs $50.00 floor).`;
        }
      }
    }

    // 7. Fail-Closed Architecture: Check Staleness of Mark Price (< 5000ms)
    const markPriceData = this._getMarkPriceData(effectiveSymbol);
    if (!markPriceData || markPriceData.price <= 0) {
      return this._reject(`Fail-closed: Missing or invalid live mark price for ${effectiveSymbol}`);
    }
    const markPriceAge = now - markPriceData.timestamp;
    if (markPriceAge > this.config.maxStalenessMs) {
      return this._reject(`Fail-closed: Mark price for ${effectiveSymbol} is stale (${markPriceAge}ms > ${this.config.maxStalenessMs}ms limit)`);
    }
    const liveMarkPrice = markPriceData.price;

    // 8. Leverage Ceiling Enforcement & Small Balance BTCUSDT Dynamic Bump
    const requestedLeverage = Number(candidate.leverage);
    if (isNaN(requestedLeverage) || requestedLeverage <= 0) {
      return this._reject(`Fail-closed: Invalid leverage requested (${candidate.leverage})`);
    }

    let effectiveLeverage = requestedLeverage;
    let dynamicLeverageApplied = false;
    let dynamicLeverageReason = null;
    const isSmallBalance = totalCapital < (this.config.smallBalanceThresholdUsdt || 50.00);

    if (effectiveSymbol === 'BTCUSDT' && isSmallBalance) {
      // Binance Futures BTCUSDT minimum lot size is 0.001 BTC (~$50 - $65 USDT notional floor)
      const btcNotionalFloor = Math.max(this.config.btcMinNotionalFloorUsdt || 50.00, liveMarkPrice * 0.001);
      const currentPurchasingPower = totalCapital * requestedLeverage;

      if (currentPurchasingPower < btcNotionalFloor && this.config.enableDynamicBtcLeverageBump !== false) {
        // Calculate dynamic leverage required to pass 50 USDT floor (with 5% buffer)
        const neededLeverage = Math.ceil(btcNotionalFloor / (totalCapital * 0.95));
        const maxSafeBtcLeverage = this.config.smallBalanceMaxBtcLeverage || 7;

        if (neededLeverage <= maxSafeBtcLeverage) {
          effectiveLeverage = Math.max(requestedLeverage, neededLeverage);
          dynamicLeverageApplied = true;
          dynamicLeverageReason = `Dynamically bumped leverage to ${effectiveLeverage}x on BTCUSDT to satisfy 50 USDT exchange notional floor with small balance ($${totalCapital.toFixed(2)} equity).`;
        } else {
          return this._reject(`Small balance ($${totalCapital.toFixed(2)}) on BTCUSDT requires ${neededLeverage}x leverage to satisfy 50 USDT notional floor (exceeds ${maxSafeBtcLeverage}x safe ceiling). Route to XRPUSDT for lower notional floor ($5.00).`);
        }
      }
    }

    if (!dynamicLeverageApplied && requestedLeverage > this.config.maxLeverage) {
      return this._reject(`Leverage violation: Requested ${requestedLeverage}x exceeds strict ceiling of ${this.config.maxLeverage}x`);
    }

    // 9. Max Concurrent Positions Check (if opening new position)
    if (!candidate.reduceOnly) {
      const openPositions = this._getOpenPositions();
      const alreadyHoldsSymbol = openPositions.some(p => (p.symbol || '').toUpperCase() === effectiveSymbol);
      if (!alreadyHoldsSymbol && openPositions.length >= this.config.maxOpenPositions) {
        return this._reject(`Exposure limit: Maximum open positions reached (${openPositions.length}/${this.config.maxOpenPositions})`);
      }
    }

    // 10. Daily Drawdown Circuit Breaker Pre-Check
    const cbStatus = this.checkCircuitBreakers();
    if (cbStatus.dailyDrawdownBreached) {
      return this._reject(`Daily drawdown limit breached (${(cbStatus.dailyDrawdownPct * 100).toFixed(2)}% <= -${(this.config.maxDailyDrawdownPct * 100).toFixed(2)}%). All trading halted for UTC day.`);
    }

    // 11. Liquidation Buffer & Distance Check (Isolated leverage)
    const entryPrice = candidate.price && candidate.price > 0 ? Number(candidate.price) : liveMarkPrice;
    const isLong = (side === 'BUY' || side === 'LONG');
    const liqDistanceCheck = this._checkLiquidationDistance(entryPrice, effectiveLeverage, isLong);
    if (!liqDistanceCheck.safe) {
      return this._reject(liqDistanceCheck.reason);
    }

    // 12. Account Capital & Fixed Fractional Position Sizing (Max 1% Capital Risk)
    // Capital risk dollar budget: e.g. 1% of total equity
    const maxRiskDollarBudget = totalCapital * this.config.maxRiskPerTradePct;

    // Projected Stop Loss Price calculation
    let slPrice = candidate.stopLossPrice;
    if (!slPrice || isNaN(slPrice) || slPrice <= 0) {
      // Default stop loss distance based on fixedStopLossPct (e.g. 0.8%)
      slPrice = isLong
        ? entryPrice * (1 - this.config.fixedStopLossPct)
        : entryPrice * (1 + this.config.fixedStopLossPct);
    }

    const pricePerUnitRisk = Math.abs(entryPrice - slPrice);
    if (pricePerUnitRisk <= 0) {
      return this._reject('Fail-closed: Stop loss price must differ from entry price to calculate risk');
    }

    // Maximum units permitted based on 1% capital risk:
    const maxUnitsFromRisk = maxRiskDollarBudget / pricePerUnitRisk;

    // Maximum units permitted based on conservative notional cap
    const maxUnitsFromNotional = (this.config.maxPositionNotionalUsdt * effectiveLeverage) / entryPrice;

    const minNotionalUsdt = this.config.minNotionalUsdt || 10.00;
    const minUnitsForNotional = (minNotionalUsdt * effectiveLeverage) / entryPrice;

    let maxPermittedQty;
    let finalQty;

    if (effectiveSymbol === 'BTCUSDT' && (isSmallBalance || dynamicLeverageApplied)) {
      // Enforce 0.001 BTC step size to satisfy 50 USDT floor
      const minBtcStepQty = 0.001;
      const maxUnitsFromEquity = (totalCapital * effectiveLeverage * 0.98) / entryPrice;
      maxPermittedQty = Math.max(minBtcStepQty, maxUnitsFromRisk);
      maxPermittedQty = Math.min(maxPermittedQty, maxUnitsFromEquity);

      if (maxPermittedQty < minBtcStepQty) {
        return this._reject(`Available equity ($${totalCapital.toFixed(2)}) is insufficient for BTC minimum contract 0.001 BTC (~$${(minBtcStepQty * entryPrice).toFixed(2)} USDT). Route to XRPUSDT.`);
      }
      finalQty = minBtcStepQty;
    } else if (effectiveSymbol === 'XRPUSDT') {
      // XRPUSDT: min notional is $5.00, step size 0.1 XRP
      const minXrpNotional = 5.00;
      const minXrpQty = Math.ceil((minXrpNotional / entryPrice) * 10) / 10;
      const maxUnitsFromEquity = (totalCapital * effectiveLeverage * 0.98) / entryPrice;
      maxPermittedQty = Math.max(minXrpQty, Math.min(maxUnitsFromRisk, (this.config.maxPositionNotionalUsdt * effectiveLeverage) / entryPrice));
      maxPermittedQty = Math.min(maxPermittedQty, maxUnitsFromEquity);
      finalQty = Math.max(minXrpQty, Math.min(candidate.quantity || minXrpQty, maxPermittedQty));
    } else if (isSmallBalance) {
      // Allow fixed minimum trade size of $10.00 USDT, bounded by available equity
      const maxUnitsFromEquity = (totalCapital * effectiveLeverage * 0.98) / entryPrice;
      const basePermitted = Math.min(maxUnitsFromRisk, maxUnitsFromNotional);
      maxPermittedQty = Math.max(minUnitsForNotional, basePermitted);
      maxPermittedQty = Math.min(maxPermittedQty, maxUnitsFromEquity);
      finalQty = Math.min(minUnitsForNotional, maxPermittedQty);
    } else {
      maxPermittedQty = Math.min(maxUnitsFromRisk, maxUnitsFromNotional);
      if (candidate.quantity && candidate.quantity > 0) {
        finalQty = Math.min(candidate.quantity, maxPermittedQty);
      } else if (candidate.notional && candidate.notional > 0) {
        const requestedQty = (candidate.notional * effectiveLeverage) / entryPrice;
        finalQty = Math.min(requestedQty, maxPermittedQty);
      } else {
        finalQty = maxPermittedQty;
      }
      if (effectiveSymbol === 'BTCUSDT') {
        finalQty = Math.max(0.001, finalQty);
      }
    }

    if (maxPermittedQty <= 0 || finalQty <= 0) {
      return this._reject('Calculated safe quantity is zero or negative');
    }

    // Precision rounding: 3 decimals for BTC, 1 for XRP, 6 for others
    const qtyDecimals = effectiveSymbol === 'BTCUSDT' ? 3 : (effectiveSymbol === 'XRPUSDT' ? 1 : 6);
    const adjustedQty = parseFloat(finalQty.toFixed(qtyDecimals));

    if (adjustedQty <= 0 || (adjustedQty * entryPrice) < 1.0) {
      return this._reject(`Calculated notional ($${(adjustedQty * entryPrice).toFixed(2)}) is below exchange minimum ($1.00)`);
    }

    const actualRiskDollar = adjustedQty * pricePerUnitRisk;
    const notionalUsdt = adjustedQty * entryPrice;

    // 13. Record timestamp for local rate limiting bucket
    this._recordOrderTimestamp(now);

    const elapsedMs = (typeof performance !== 'undefined' && performance.now) ? (performance.now() - startTime) : 0;

    return {
      approved: true,
      reason: null,
      adjustedQty,
      metadata: {
        symbol: effectiveSymbol,
        originalSymbol: symbol,
        routedToAltcoin,
        routedReason,
        side,
        entryPrice,
        stopLossPrice: slPrice,
        liquidationPrice: liqDistanceCheck.liquidationPrice,
        liquidationDistancePct: liqDistanceCheck.distancePct,
        leverage: effectiveLeverage,
        requestedLeverage,
        dynamicLeverageApplied,
        dynamicLeverageReason,
        notionalUsdt: parseFloat(notionalUsdt.toFixed(2)),
        capitalRiskUsdt: parseFloat(actualRiskDollar.toFixed(4)),
        capitalRiskPct: parseFloat(((actualRiskDollar / totalCapital) * 100).toFixed(2)),
        totalCapital: parseFloat(totalCapital.toFixed(2)),
        validationTimeMs: parseFloat(elapsedMs.toFixed(3))
      }
    };
  }

  /**
   * Evaluates whether an account balance is small (< 10 USDT) and routes to lower-minimum
   * altcoin pair (e.g. XRPUSDT) or confirms dynamic leverage bump availability on BTCUSDT
   * to avoid exchange notional floor rejections.
   *
   * @param {string} symbol - Candidate symbol (e.g. BTCUSDT)
   * @param {number} totalCapital - Total account equity in USDT
   * @param {number} [markPrice] - Current mark price
   * @returns {{ recommendedSymbol: string, shouldRoute: boolean, canBumpLeverage: boolean, requiredLeverage: number, reason: string }}
   */
  suggestOrRoutePair(symbol, totalCapital, markPrice = 65000.0) {
    const norm = (symbol || '').toUpperCase().trim();
    const threshold = this.config.smallBalanceThresholdForAltcoin || 10.00;
    const isSmall = totalCapital < threshold;

    if (norm === 'BTCUSDT' && (isSmall || totalCapital < (this.config.smallBalanceThresholdUsdt || 50.00))) {
      const btcFloor = Math.max(this.config.btcMinNotionalFloorUsdt || 50.00, markPrice * 0.001);
      const neededLeverage = Math.ceil(btcFloor / (totalCapital * 0.95));
      const canBump = neededLeverage <= (this.config.smallBalanceMaxBtcLeverage || 7);

      if (isSmall) {
        return {
          recommendedSymbol: this.config.smallBalanceAltcoinPair || 'XRPUSDT',
          shouldRoute: true,
          canBumpLeverage: canBump,
          requiredLeverage: neededLeverage,
          reason: `Small balance ($${totalCapital.toFixed(2)} USDT < $10.00): Routed to ${this.config.smallBalanceAltcoinPair || 'XRPUSDT'} ($5.00 min notional) to avoid BTCUSDT 50 USDT notional floor rejection.`
        };
      }

      return {
        recommendedSymbol: 'BTCUSDT',
        shouldRoute: false,
        canBumpLeverage: canBump,
        requiredLeverage: neededLeverage,
        reason: canBump
          ? `BTCUSDT requires ${neededLeverage}x leverage to satisfy 50 USDT floor for $${totalCapital.toFixed(2)} equity.`
          : `Balance requires ${neededLeverage}x leverage which exceeds safe ceiling (${this.config.smallBalanceMaxBtcLeverage}x). Route to XRPUSDT.`
      };
    }

    return {
      recommendedSymbol: norm,
      shouldRoute: false,
      canBumpLeverage: false,
      requiredLeverage: 1,
      reason: 'Standard balance satisfies exchange notional requirements.'
    };
  }

  // ============================================================
  // CIRCUIT BREAKER ENGINE
  // ============================================================

  /**
   * Evaluates all global circuit breakers:
   *  - Daily drawdown against starting equity at 00:00 UTC
   *  - Consecutive loss cooldown timer
   *  - Rate limiting health
   *
   * @returns {{
   *   tradingHalted: boolean,
   *   haltReason: string | null,
   *   dailyDrawdownBreached: boolean,
   *   dailyDrawdownPct: number,
   *   currentDailyPnl: number,
   *   startingDailyEquity: number,
   *   currentEquity: number,
   *   consecutiveLosses: number,
   *   cooldownActive: boolean,
   *   cooldownRemainingMs: number
   * }}
   */
  checkCircuitBreakers() {
    this._checkUtcDayRollover();

    const balanceData = this._getBalanceData();
    const currentEquity = balanceData ? (balanceData.walletBalance + (balanceData.unrealizedPnl || 0)) : 100.0;
    const startingEquity = this._getStartingDailyEquity(currentEquity);

    const currentDailyPnl = currentEquity - startingEquity;
    const dailyDrawdownPct = startingEquity > 0 ? (currentDailyPnl / startingEquity) : 0;

    const dailyDrawdownBreached = dailyDrawdownPct <= -this.config.maxDailyDrawdownPct;

    if (dailyDrawdownBreached && !this.tradingHalted) {
      this.tripCircuitBreaker(
        `Max daily drawdown breached: ${(dailyDrawdownPct * 100).toFixed(2)}% (limit: -${(this.config.maxDailyDrawdownPct * 100).toFixed(2)}%). All trading halted for remainder of UTC day.`,
        true // lock until UTC midnight
      );
    }

    const now = Date.now();
    const cooldownActive = this.cooldownUntil > now;
    const cooldownRemainingMs = cooldownActive ? (this.cooldownUntil - now) : 0;

    const consecutiveLosses = this._getConsecutiveLossCount();

    return {
      tradingHalted: this.tradingHalted,
      haltReason: this.haltReason,
      dailyDrawdownBreached,
      dailyDrawdownPct: parseFloat(dailyDrawdownPct.toFixed(4)),
      currentDailyPnl: parseFloat(currentDailyPnl.toFixed(2)),
      startingDailyEquity: parseFloat(startingEquity.toFixed(2)),
      currentEquity: parseFloat(currentEquity.toFixed(2)),
      consecutiveLosses,
      cooldownActive,
      cooldownRemainingMs
    };
  }

  /**
   * Trips the circuit breaker, sets tradingHalted = true, and cancels pending orders.
   *
   * @param {string} reason
   * @param {boolean} [untilUtcMidnight=false]
   */
  tripCircuitBreaker(reason, untilUtcMidnight = false) {
    this.tradingHalted = true;
    this.haltReason = reason;
    this.haltedUntilUtcMidnight = untilUtcMidnight;

    // Cancel all open pending orders via localStore callback
    try {
      if (this.localStore && typeof this.localStore.cancelPendingOrders === 'function') {
        this.localStore.cancelPendingOrders();
      }
    } catch (_) {}

    // Emit event if store supports it
    try {
      if (this.localStore && typeof this.localStore.setTradingHalted === 'function') {
        this.localStore.setTradingHalted(true, reason);
      }
    } catch (_) {}
  }

  /**
   * Resets the circuit breaker if authorized.
   *
   * @param {string} [operatorReason='Manual operator reset']
   */
  resetCircuitBreaker(operatorReason = 'Manual operator reset') {
    this.tradingHalted = false;
    this.haltReason = null;
    this.haltedUntilUtcMidnight = false;
    this.cooldownUntil = 0;

    try {
      if (this.localStore && typeof this.localStore.setTradingHalted === 'function') {
        this.localStore.setTradingHalted(false, operatorReason);
      }
    } catch (_) {}
  }

  // ============================================================
  // POST-TRADE OUTCOME RECORDING & CONSECUTIVE LOSS LIMITER
  // ============================================================

  /**
   * Records a closed trade into SQLite / store, evaluates consecutive losses,
   * and triggers the 2-hour cooldown timer if 3 consecutive losses occur.
   *
   * @param {Object} tradeData
   * @param {string} tradeData.id - Unique trade or position identifier
   * @param {string} tradeData.symbol - Contract symbol
   * @param {'LONG'|'SHORT'|'BUY'|'SELL'} tradeData.side
   * @param {number} tradeData.entryPrice
   * @param {number} tradeData.exitPrice
   * @param {number} tradeData.qty
   * @param {number} tradeData.realizedPnl - Net realized PnL in USDT
   * @param {number} [tradeData.commission=0]
   * @param {number} [tradeData.closedAt=Date.now()]
   * @returns {{
   *   consecutiveLosses: number,
   *   cooldownTriggered: boolean,
   *   cooldownUntil: number,
   *   circuitBreakerState: Object
   * }}
   */
  recordTradeResult(tradeData) {
    if (!tradeData || typeof tradeData !== 'object') {
      return { consecutiveLosses: 0, cooldownTriggered: false, cooldownUntil: 0, circuitBreakerState: this.checkCircuitBreakers() };
    }

    const record = {
      id: tradeData.id || `trade_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      symbol: (tradeData.symbol || 'BTCUSDT').toUpperCase(),
      side: (tradeData.side || 'LONG').toUpperCase(),
      entryPrice: Number(tradeData.entryPrice || 0),
      exitPrice: Number(tradeData.exitPrice || 0),
      qty: Number(tradeData.qty || 0),
      realizedPnl: Number(tradeData.realizedPnl || 0),
      commission: Number(tradeData.commission || 0),
      closedAt: Number(tradeData.closedAt || Date.now())
    };

    // 1. Persist to SQLite
    this._persistTradeToDb(record);

    // 2. Keep in-memory cache for fast synchronous checks
    this._recentClosedTrades.unshift(record);
    if (this._recentClosedTrades.length > 50) {
      this._recentClosedTrades.pop();
    }

    // 3. Evaluate Consecutive Losses
    const consecutiveLosses = this._getConsecutiveLossCount();
    let cooldownTriggered = false;

    if (consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.cooldownUntil = Date.now() + this.config.consecutiveLossCooldownMs;
      cooldownTriggered = true;
      this.tripCircuitBreaker(
        `${consecutiveLosses} consecutive loss limit reached. Mandatory ${this.config.consecutiveLossCooldownMs / 3600000}h cooldown engaged.`,
        false
      );
    }

    // 4. Re-evaluate Daily Drawdown
    const cbState = this.checkCircuitBreakers();

    return {
      consecutiveLosses,
      cooldownTriggered,
      cooldownUntil: this.cooldownUntil,
      circuitBreakerState: cbState
    };
  }

  // ============================================================
  // INTERNAL QUANTITATIVE CONTROLS & CALCULATORS
  // ============================================================

  /**
   * Calculates projected liquidation price and distance for isolated positions.
   * Formula for USDT-M Isolated Futures:
   *   Long:  LiqPrice = Entry * (1 - 1/Leverage + MMR)
   *   Short: LiqPrice = Entry * (1 + 1/Leverage - MMR)
   *
   * @param {number} entryPrice
   * @param {number} leverage
   * @param {boolean} isLong
   * @returns {{ safe: boolean, liquidationPrice: number, distancePct: number, reason: string | null }}
   */
  _checkLiquidationDistance(entryPrice, leverage, isLong) {
    const mmr = this.config.maintenanceMarginRate; // e.g. 0.004 (0.4%)
    let liqPrice;

    if (isLong) {
      liqPrice = entryPrice * (1 - (1 / leverage) + mmr);
      liqPrice = Math.max(0, liqPrice);
    } else {
      liqPrice = entryPrice * (1 + (1 / leverage) - mmr);
    }

    const distancePct = Math.abs(entryPrice - liqPrice) / entryPrice;

    if (distancePct < this.config.minLiquidationDistancePct) {
      return {
        safe: false,
        liquidationPrice: parseFloat(liqPrice.toFixed(2)),
        distancePct: parseFloat(distancePct.toFixed(4)),
        reason: `Liquidation buffer violation: Projected liquidation price is $${liqPrice.toFixed(2)} (${(distancePct * 100).toFixed(2)}% distance), which is under the minimum safe buffer of ${(this.config.minLiquidationDistancePct * 100).toFixed(2)}%`
      };
    }

    return {
      safe: true,
      liquidationPrice: parseFloat(liqPrice.toFixed(2)),
      distancePct: parseFloat(distancePct.toFixed(4)),
      reason: null
    };
  }

  /**
   * Frequency / Rate Limiter: Max 5 orders/sec, Max 50 orders/min.
   *
   * @param {number} now
   * @returns {{ allowed: boolean, reason: string | null }}
   */
  _checkRateLimits(now) {
    // Prune timestamps older than 60 seconds
    const oneMinuteAgo = now - 60000;
    this.orderTimestamps = this.orderTimestamps.filter(ts => ts > oneMinuteAgo);

    // Check last second
    const oneSecondAgo = now - 1000;
    let countLastSec = 0;
    for (let i = this.orderTimestamps.length - 1; i >= 0; i--) {
      if (this.orderTimestamps[i] > oneSecondAgo) {
        countLastSec++;
      } else {
        break;
      }
    }

    if (countLastSec >= this.config.maxOrdersPerSecond) {
      return {
        allowed: false,
        reason: `Rate limit breach: Max ${this.config.maxOrdersPerSecond} orders/second exceeded (${countLastSec} orders in past 1000ms)`
      };
    }

    // Check last minute
    if (this.orderTimestamps.length >= this.config.maxOrdersPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit breach: Max ${this.config.maxOrdersPerMinute} orders/minute exceeded (${this.orderTimestamps.length} orders in past 60s)`
      };
    }

    return { allowed: true, reason: null };
  }

  _recordOrderTimestamp(ts) {
    this.orderTimestamps.push(ts);
  }

  /**
   * Counts consecutive loss trades starting from the most recent.
   * @returns {number}
   */
  _getConsecutiveLossCount() {
    let count = 0;
    for (const trade of this._recentClosedTrades) {
      if (trade.realizedPnl < 0) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Checks if the UTC day has rolled over at 00:00 UTC.
   */
  _checkUtcDayRollover() {
    const todayUtc = this._getCurrentUtcDayString();
    if (todayUtc !== this.currentUtcDay) {
      // Day has rolled over
      this.currentUtcDay = todayUtc;

      // Unhalt if halted specifically for the previous UTC day
      if (this.haltedUntilUtcMidnight) {
        this.tradingHalted = false;
        this.haltReason = null;
        this.haltedUntilUtcMidnight = false;
      }

      // Reset daily starting equity
      const balanceData = this._getBalanceData();
      if (balanceData) {
        const currentEquity = balanceData.walletBalance + (balanceData.unrealizedPnl || 0);
        this._setStartingDailyEquity(currentEquity);
      }
    }
  }

  _getCurrentUtcDayString() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // ============================================================
  // DATA ACCESSORS (FAIL-CLOSED COMPATIBILITY LAYER)
  // ============================================================

  _getMarkPriceData(symbol) {
    if (!this.localStore) return null;

    // Check if store provides a helper function
    if (typeof this.localStore.getMarkPriceData === 'function') {
      return this.localStore.getMarkPriceData(symbol);
    }

    // Direct methods
    let price = 0;
    let timestamp = 0;

    if (typeof this.localStore.getMarkPrice === 'function') {
      price = this.localStore.getMarkPrice(symbol);
    } else if (this.localStore.currentMarkPrice) {
      price = Number(this.localStore.currentMarkPrice);
    }

    if (typeof this.localStore.getMarkPriceTimestamp === 'function') {
      timestamp = this.localStore.getMarkPriceTimestamp(symbol);
    } else if (this.localStore.markPriceTimestamp) {
      timestamp = Number(this.localStore.markPriceTimestamp);
    } else if (this.localStore.lastMarkPriceUpdate) {
      timestamp = Number(this.localStore.lastMarkPriceUpdate);
    } else if (price > 0) {
      // Fallback if localStore doesn't record timestamps
      timestamp = Date.now();
    }

    return { price, timestamp };
  }

  _getBalanceData() {
    if (!this.localStore) return null;

    if (typeof this.localStore.getBalanceData === 'function') {
      return this.localStore.getBalanceData();
    }

    let walletBalance = 0;
    let unrealizedPnl = 0;
    let timestamp = 0;

    if (typeof this.localStore.getWalletBalance === 'function') {
      walletBalance = this.localStore.getWalletBalance();
    } else if (this.localStore.walletBalance !== undefined) {
      walletBalance = Number(this.localStore.walletBalance);
    }

    if (typeof this.localStore.getUnrealizedPnl === 'function') {
      unrealizedPnl = this.localStore.getUnrealizedPnl();
    } else if (this.localStore.dailyPnl !== undefined) {
      unrealizedPnl = Number(this.localStore.dailyPnl);
    }

    if (typeof this.localStore.getBalanceTimestamp === 'function') {
      timestamp = this.localStore.getBalanceTimestamp();
    } else if (this.localStore.balanceTimestamp) {
      timestamp = Number(this.localStore.balanceTimestamp);
    } else if (this.localStore.lastBalanceUpdate) {
      timestamp = Number(this.localStore.lastBalanceUpdate);
    } else if (walletBalance > 0) {
      timestamp = Date.now();
    }

    return { walletBalance, unrealizedPnl, timestamp };
  }

  _getOpenPositions() {
    if (!this.localStore) return [];
    if (typeof this.localStore.getOpenPositions === 'function') {
      return this.localStore.getOpenPositions() || [];
    }
    if (Array.isArray(this.localStore.positions)) {
      return this.localStore.positions;
    }
    return [];
  }

  _getStartingDailyEquity(fallback) {
    if (this.localStore) {
      if (typeof this.localStore.getStartingDailyEquity === 'function') {
        const val = this.localStore.getStartingDailyEquity();
        if (val && val > 0) return val;
      } else if (this.localStore.startingDailyEquity && this.localStore.startingDailyEquity > 0) {
        return Number(this.localStore.startingDailyEquity);
      }
    }
    return fallback;
  }

  _setStartingDailyEquity(val) {
    if (this.localStore) {
      if (typeof this.localStore.setStartingDailyEquity === 'function') {
        this.localStore.setStartingDailyEquity(val);
      } else {
        this.localStore.startingDailyEquity = val;
      }
    }
  }

  _reject(reason) {
    return {
      approved: false,
      reason,
      adjustedQty: null
    };
  }

  // ============================================================
  // SQLITE & LOCAL STORAGE PERSISTENCE LAYER
  // ============================================================

  _initDatabase(db) {
    if (db) return db;

    // Check if Node.js DatabaseSync is available
    try {
      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        // Dynamically import or require node:sqlite
        const nodeSqlite = typeof require === 'function' ? require('node:sqlite') : null;
        if (nodeSqlite && nodeSqlite.DatabaseSync) {
          return new nodeSqlite.DatabaseSync(':memory:');
        }
      }
    } catch (_) {}

    // In-memory array fallback if running purely in browser or without sqlite library
    return {
      _trades: [],
      isMock: true
    };
  }

  _setupSchema() {
    if (!this.db || this.db.isMock) return;

    try {
      if (typeof this.db.exec === 'function') {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS closed_trades (
            id TEXT PRIMARY KEY,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL,
            entry_price REAL NOT NULL,
            exit_price REAL NOT NULL,
            qty REAL NOT NULL,
            realized_pnl REAL NOT NULL,
            commission REAL DEFAULT 0,
            closed_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_closed_trades_time ON closed_trades(closed_at DESC);
        `);
      }
    } catch (_) {}
  }

  _persistTradeToDb(record) {
    // 1. If SQLite DB is present:
    if (this.db && !this.db.isMock) {
      try {
        if (typeof this.db.prepare === 'function') {
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO closed_trades (id, symbol, side, entry_price, exit_price, qty, realized_pnl, commission, closed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          stmt.run(
            record.id,
            record.symbol,
            record.side,
            record.entryPrice,
            record.exitPrice,
            record.qty,
            record.realizedPnl,
            record.commission,
            record.closedAt
          );
          return;
        }
      } catch (_) {}
    }

    // 2. In browser environment: persist to localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const key = 'cryptorium_closed_trades_v1';
        const existingRaw = localStorage.getItem(key);
        const list = existingRaw ? JSON.parse(existingRaw) : [];
        list.unshift(record);
        if (list.length > 200) list.length = 200;
        localStorage.setItem(key, JSON.stringify(list));
      } catch (_) {}
    }
  }

  _loadRecentTradesFromDb() {
    if (this.db && !this.db.isMock) {
      try {
        if (typeof this.db.prepare === 'function') {
          const stmt = this.db.prepare(`
            SELECT id, symbol, side, entry_price as entryPrice, exit_price as exitPrice, qty, realized_pnl as realizedPnl, commission, closed_at as closedAt
            FROM closed_trades
            ORDER BY closed_at DESC
            LIMIT 50
          `);
          const rows = stmt.all ? stmt.all() : [];
          if (Array.isArray(rows) && rows.length > 0) {
            this._recentClosedTrades = rows;
            return;
          }
        }
      } catch (_) {}
    }

    // Fallback: browser localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const key = 'cryptorium_closed_trades_v1';
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this._recentClosedTrades = parsed.slice(0, 50);
          }
        }
      } catch (_) {}
    }
  }

  _createDefaultStore() {
    return {
      walletBalance: 100.0,
      balanceTimestamp: Date.now(),
      dailyPnl: 0.0,
      currentMarkPrice: 65000.0,
      markPriceTimestamp: Date.now(),
      positions: [],
      startingDailyEquity: 100.0,
      cancelPendingOrders: () => {}
    };
  }
}

// Global browser window fallback
if (typeof window !== 'undefined') {
  window.RiskEngine = RiskEngine;
}

export default RiskEngine;
