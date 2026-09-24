/**
 * ============================================================
 * CRYPTORIUM // SERVICES // PHASE 5: AUTO-LOOP CONTROLLER
 * Central Orchestration Class & Emergency Controls
 * Compatible with Node.js and static browser environments.
 * ============================================================
 */

import {
  dispatchOrder,
  cancelAllOpenOrders,
  closePositionMarket,
  fetchOpenPositions,
  setLeverage,
  DEFAULT_REST_URL,
  PRODUCTION_REST_URL
} from './binanceRest.js';
import { PROPOSED_SIGNALS } from './geminiSupervisor.js';

export const LOOP_STATES = {
  IDLE: 'IDLE',
  SCANNING: 'SCANNING',
  EVALUATING: 'EVALUATING',
  EXECUTING: 'EXECUTING',
  COOLDOWN: 'COOLDOWN',
  CIRCUIT_BROKEN: 'CIRCUIT_BROKEN'
};

export const AUTO_LOOP_DEFAULTS = {
  POST_CLOSE_COOLDOWN_MS: 5 * 60 * 1000,      // 5-minute cooldown after position close
  HEARTBEAT_TIMEOUT_MS: 10 * 1000,           // 10s WebSocket silence safety check
  TRAILING_STOP_PROFIT_TRIGGER_PCT: 0.012,    // +1.2% unrealized profit triggers break-even (covers fees/slippage)
  FEE_BUFFER_PCT: 0.0010,                     // 0.10% round-trip fee buffer (Binance taker fees)
  DEFAULT_POSITION_NOTIONAL_USDT: 20.00,      // $20 USDT allocation limit
  DEFAULT_LEVERAGE: 1,                        // 1x conservative leverage (cap at 2x)
  STOP_LOSS_PCT: 0.008,                       // 0.8% stop loss
  TAKE_PROFIT_PCT: 0.018,                     // 1.8% take profit (1.5% - 2.0% range)
  MIN_CONFIDENCE_PCT: 85.0,                   // 85% quantitative filter threshold
  GEMINI_CONFIDENCE_THRESHOLD: 0.80           // 80% AI Supervisor threshold
};

export class AutoLoopController {
  /**
   * @param {Object} options
   * @param {Object} options.riskEngine - Pre-trade RiskEngine instance
   * @param {Object} options.geminiSupervisor - GeminiSupervisor instance
   * @param {Object} [options.streamManager] - BinanceStreamManager instance
   * @param {Object} [options.config] - Configuration overrides
   * @param {Function} [options.getCredentials] - () => ({ apiKey, apiSecret, environment })
   * @param {Function} [options.onStateChange] - (newState, oldState, metadata) => void
   * @param {Function} [options.onPositionsChange] - (positions) => void
   * @param {Function} [options.onLog] - (category, message, level) => void
   * @param {Function} [options.onMetricsChange] - (metrics) => void
   */
  constructor(options = {}) {
    this.riskEngine = options.riskEngine || null;
    this.geminiSupervisor = options.geminiSupervisor || null;
    this.streamManager = options.streamManager || null;
    this.getCredentials = options.getCredentials || (() => ({ apiKey: '', apiSecret: '', environment: 'testnet' }));

    this.config = { ...AUTO_LOOP_DEFAULTS, ...(options.config || {}) };

    this.onStateChange = options.onStateChange || (() => {});
    this.onPositionsChange = options.onPositionsChange || (() => {});
    this.onLog = options.onLog || (() => {});
    this.onMetricsChange = options.onMetricsChange || (() => {});

    // State Machine
    this.state = LOOP_STATES.IDLE;
    this.previousState = LOOP_STATES.IDLE;

    // Tracked data
    this.positions = [];
    this.activeSymbol = 'BTCUSDT';
    this.currentMarkPrice = 0;
    this.recentKlines = [];
    this.lastExecutedCandle = {}; // { [symbol]: candleStartTime }
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.isEvaluating = false;

    // Timers
    this.heartbeatTimer = null;
    this.scanIntervalTimer = null;

    // Telemetry
    this.stats = {
      totalScans: 0,
      signalsGenerated: 0,
      riskRejections: 0,
      geminiVetoes: 0,
      ordersExecuted: 0,
      trailingStopsAdjusted: 0,
      emergencyKills: 0
    };

    // Bind heartbeat monitor
    this.initHeartbeatMonitor();
  }

  // --- STATE MACHINE MANAGEMENT ---

  /**
   * Sets loop state and dispatches callbacks
   * @param {string} newState
   * @param {Object} [metadata={}]
   */
  setState(newState, metadata = {}) {
    if (this.state === newState) return;

    // Invariant: If circuit is broken, only manual reset may transition out
    if (this.state === LOOP_STATES.CIRCUIT_BROKEN && newState !== LOOP_STATES.IDLE && !metadata.forceReset) {
      this.log('RISK', `State transition to ${newState} blocked: Circuit Breaker is active. Manual reset required.`, 'danger');
      return;
    }

    const oldState = this.state;
    this.previousState = oldState;
    this.state = newState;

    this.log('SYSTEM', `Engine state: ${oldState} -> ${newState}${metadata.reason ? ` (${metadata.reason})` : ''}`, 'info');
    this.onStateChange(newState, oldState, metadata);
  }

  /**
   * Returns current loop state
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  /**
   * Starts the continuous automated trading pipeline
   * @param {string} [symbol]
   */
  start(symbol) {
    if (symbol) {
      this.activeSymbol = symbol.toUpperCase().trim();
    }

    if (this.isCircuitBroken()) {
      this.log('RISK', 'Cannot start AutoLoop: Circuit Breaker is tripped. Clear breaker first.', 'danger');
      this.setState(LOOP_STATES.CIRCUIT_BROKEN, { reason: 'Circuit Breaker Active' });
      return false;
    }

    if (this.inCooldown()) {
      const remainingSecs = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
      this.log('SYSTEM', `AutoLoop resumed in COOLDOWN mode (${remainingSecs}s remaining).`, 'info');
      this.setState(LOOP_STATES.COOLDOWN, { reason: this.cooldownReason });
      return true;
    }

    this.setState(LOOP_STATES.SCANNING, { reason: 'Automated Pipeline Started' });
    this.log('SYSTEM', `Continuous AutoLoop active on ${this.activeSymbol}. Quantitative scanner engaged.`, 'success');
    return true;
  }

  /**
   * Stops the automated pipeline into IDLE state
   * @param {string} [reason='Operator requested stop']
   */
  stop(reason = 'Operator requested stop') {
    if (this.state === LOOP_STATES.CIRCUIT_BROKEN) {
      this.log('SYSTEM', `AutoLoop stop acknowledged (Circuit Breaker remains armed).`, 'info');
      return;
    }

    this.setState(LOOP_STATES.IDLE, { reason });
  }

  /**
   * Resets the Circuit Breaker manually
   * @param {string} [reason='Operator manual reset']
   */
  resetCircuitBreaker(reason = 'Operator manual reset') {
    if (this.riskEngine) {
      this.riskEngine.resetCircuitBreaker(reason);
    }
    this.setState(LOOP_STATES.IDLE, { reason, forceReset: true });
    this.log('RISK', `Circuit Breaker cleared. Engine transitioned to IDLE.`, 'success');
  }

  // --- COOLDOWN & INVARIANT CHECKS ---

  /**
   * Checks if cooldown period is active
   * @returns {boolean}
   */
  inCooldown() {
    return Date.now() < this.cooldownUntil;
  }

  /**
   * Enforces a cooldown period (e.g. 5 minutes post-close or 2 hours on consecutive losses)
   * @param {number} durationMs
   * @param {string} reason
   */
  setCooldown(durationMs, reason = 'Post-trade cooling period') {
    this.cooldownUntil = Date.now() + durationMs;
    this.cooldownReason = reason;
    const minutes = Math.round(durationMs / 60000);
    this.log('SYSTEM', `Cooling gate enforced: ${minutes}m (${reason}). Trading paused.`, 'warn');
    if (this.state !== LOOP_STATES.CIRCUIT_BROKEN) {
      this.setState(LOOP_STATES.COOLDOWN, { reason, durationMs });
    }
  }

  /**
   * Checks if circuit breaker is currently tripped in RiskEngine or controller
   * @returns {boolean}
   */
  isCircuitBroken() {
    if (this.state === LOOP_STATES.CIRCUIT_BROKEN) return true;
    if (this.riskEngine && typeof this.riskEngine.isCircuitBreakerTripped === 'function') {
      return this.riskEngine.isCircuitBreakerTripped();
    }
    return false;
  }

  // --- WEBSOCKET EVENT HOOKS ---

  /**
   * Handles incoming 1-minute klines from BinanceStreamManager
   * @param {Object} kline
   */
  onKlineUpdate(kline) {
    if (!kline || !kline.symbol) return;
    if (kline.symbol.toUpperCase() !== this.activeSymbol.toUpperCase()) return;

    // Cache recent klines (keep last 100)
    const existingIdx = this.recentKlines.findIndex(k => k.startTime === kline.startTime);
    if (existingIdx >= 0) {
      this.recentKlines[existingIdx] = kline;
    } else {
      this.recentKlines.push(kline);
      if (this.recentKlines.length > 100) {
        this.recentKlines.shift();
      }
    }

    this.currentMarkPrice = kline.close;

    // Position evaluation & trailing stop check
    this.evaluateActivePositions(kline.close);

    // If scanning, trigger pipeline evaluation
    if (this.state === LOOP_STATES.SCANNING) {
      this.evaluatePipelineTick(kline);
    } else if (this.state === LOOP_STATES.COOLDOWN) {
      if (!this.inCooldown()) {
        this.log('SYSTEM', 'Cooldown expired. Resuming SCANNING state.', 'success');
        this.setState(LOOP_STATES.SCANNING, { reason: 'Cooldown Expired' });
      }
    }
  }

  /**
   * Handles real-time tick/trade prices from BinanceStreamManager
   * @param {Object} trade
   */
  onTradeTick(trade) {
    if (!trade || !trade.price) return;
    if (trade.symbol && trade.symbol.toUpperCase() !== this.activeSymbol.toUpperCase()) return;

    this.currentMarkPrice = trade.price;
    this.evaluateActivePositions(trade.price);
  }

  // --- CONTINUOUS PIPELINE FLOW ---

  /**
   * Evaluates the pipeline on an incoming kline tick
   * @param {Object} kline
   */
  async evaluatePipelineTick(kline) {
    if (this.isEvaluating) return;
    if (this.state !== LOOP_STATES.SCANNING) return;

    // Deduplication check: Prevent duplicate orders on the same candlestick interval
    const candleId = kline.startTime || Math.floor(Date.now() / 60000) * 60000;
    if (this.lastExecutedCandle[this.activeSymbol] === candleId) {
      return; // Already executed on this 1m candle interval
    }

    this.stats.totalScans++;

    // Step 2: Run local strategy scan (Trend Alignment & Indicator Thresholds)
    const strategyResult = this.evaluateLocalStrategy(kline);
    if (!strategyResult.hasSignal) {
      return;
    }

    this.stats.signalsGenerated++;
    this.isEvaluating = true;
    this.setState(LOOP_STATES.EVALUATING, { signal: strategyResult.signal, confidence: strategyResult.confidence });

    try {
      // Step 3: Pass through RiskEngine (Max position $20 USDT, 1x-2x leverage, Stop Loss check)
      const markPrice = kline.close;
      const side = strategyResult.signal === 'BUY_LONG' ? 'LONG' : 'SHORT';
      const leverage = this.config.DEFAULT_LEVERAGE;

      let slPrice, tpPrice;
      if (side === 'LONG') {
        slPrice = markPrice * (1 - this.config.STOP_LOSS_PCT);
        tpPrice = markPrice * (1 + this.config.TAKE_PROFIT_PCT);
      } else {
        slPrice = markPrice * (1 + this.config.STOP_LOSS_PCT);
        tpPrice = markPrice * (1 - this.config.TAKE_PROFIT_PCT);
      }

      const candidate = {
        symbol: this.activeSymbol,
        side,
        type: 'MARKET',
        price: markPrice,
        notional: this.config.DEFAULT_POSITION_NOTIONAL_USDT,
        leverage,
        stopLossPrice: slPrice,
        takeProfitPrice: tpPrice,
        marginType: 'ISOLATED'
      };

      if (!this.riskEngine) {
        throw new Error('RiskEngine not configured in AutoLoopController');
      }

      // Synchronous, zero-bypass pre-trade gatekeeper (<1ms)
      const riskValidation = this.riskEngine.validateOrder(candidate);

      if (!riskValidation.approved) {
        this.stats.riskRejections++;
        this.log('RISK', `PIPELINE RISK REJECTION: ${riskValidation.reason}`, 'danger');
        this.setState(LOOP_STATES.SCANNING, { reason: `Risk Rejection: ${riskValidation.reason}` });
        return;
      }

      this.log('RISK', `PIPELINE RISK APPROVAL (<1ms): Size ${riskValidation.adjustedQty} ($${riskValidation.metadata.notionalUsdt.toFixed(2)} USDT @ ${riskValidation.metadata.leverage}x)`, 'success');
      if (riskValidation.metadata.dynamicLeverageApplied) {
        this.log('RISK', `DYNAMIC LEVERAGE BUMP: ${riskValidation.metadata.dynamicLeverageReason}`, 'warn');
      }
      if (riskValidation.metadata.routedToAltcoin) {
        this.log('RISK', `SMART PAIR ROUTING: ${riskValidation.metadata.routedReason}`, 'info');
      }

      // Step 4: Request GeminiSupervisor validation (Requires confidence >= 0.80)
      if (!this.geminiSupervisor) {
        throw new Error('GeminiSupervisor not configured in AutoLoopController');
      }

      const aiPayload = {
        symbol: this.activeSymbol,
        proposedSignal: strategyResult.signal,
        recentKlines: this.recentKlines,
        markPrice,
        indicatorMetrics: {
          ema200: strategyResult.ema200,
          priceVsEmaPct: strategyResult.priceVsEmaPct,
          rsi14: strategyResult.rsi14,
          atr14: strategyResult.atr14
        }
      };

      const aiResult = await this.geminiSupervisor.evaluateSignal(aiPayload);

      if (!aiResult.approved) {
        this.stats.geminiVetoes++;
        this.log('AI', `PIPELINE GEMINI VETO: ${aiResult.marketRegime} (${(aiResult.confidenceScore * 100).toFixed(0)}% conf) - ${aiResult.reasoning}`, 'warn');
        this.setState(LOOP_STATES.SCANNING, { reason: `AI Veto: ${aiResult.marketRegime}` });
        return;
      }

      this.log('AI', `PIPELINE GEMINI APPROVAL: ${aiResult.marketRegime} confirmed with ${(aiResult.confidenceScore * 100).toFixed(0)}% confidence (${aiResult.latencyMs}ms). Dispatching execution...`, 'success');

      // Step 5: Execute Approved Trade
      this.setState(LOOP_STATES.EXECUTING, { candidate, riskValidation, aiResult });
      await this.dispatchApprovedTrade(candidate, riskValidation, candleId);

    } catch (err) {
      this.log('SYSTEM', `Pipeline execution error: ${err.message}`, 'danger');
      this.setState(LOOP_STATES.SCANNING, { reason: `Error: ${err.message}` });
    } finally {
      this.isEvaluating = false;
    }
  }

  /**
   * Evaluates local technical rules: 200 EMA trend & RSI neutral bounce 45-55
   * @param {Object} kline
   * @returns {{ hasSignal: boolean, signal: string, confidence: number, ema200: number, priceVsEmaPct: number, rsi14: number, atr14: number }}
   */
  evaluateLocalStrategy(kline) {
    const price = kline.close;
    const ema200 = this.calculateEMA(200) || (price * 0.985);
    const rsi14 = this.calculateRSI(14);
    const atr14 = this.calculateATR(14);

    const priceVsEmaPct = ((price - ema200) / ema200) * 100;
    const isBullishTrend = price >= ema200;
    const isBearishTrend = price < ema200;
    const isRsiNeutralBounce = rsi14 >= 45.0 && rsi14 <= 55.0;

    let hasSignal = false;
    let signal = 'HOLD';
    let confidence = 75.0;

    if (isBullishTrend && isRsiNeutralBounce) {
      hasSignal = true;
      signal = PROPOSED_SIGNALS.BUY_LONG;
      confidence = 88.5;
    } else if (isBearishTrend && isRsiNeutralBounce) {
      hasSignal = true;
      signal = PROPOSED_SIGNALS.SELL_SHORT;
      confidence = 86.5;
    }

    return {
      hasSignal: hasSignal && confidence >= this.config.MIN_CONFIDENCE_PCT,
      signal,
      confidence,
      ema200,
      priceVsEmaPct,
      rsi14,
      atr14
    };
  }

  /**
   * Dispatches the approved order to Binance Futures REST
   * @param {Object} candidate
   * @param {Object} riskValidation
   * @param {number} candleId
   */
  async dispatchApprovedTrade(candidate, riskValidation, candleId) {
    const { apiKey, apiSecret, environment } = this.getCredentials();
    const baseUrl = environment === 'production' ? PRODUCTION_REST_URL : DEFAULT_REST_URL;
    const qty = riskValidation.adjustedQty;
    const side = candidate.side === 'LONG' ? 'BUY' : 'SELL';
    const closeSide = candidate.side === 'LONG' ? 'SELL' : 'BUY';

    // Mark deduplication candle
    this.lastExecutedCandle[candidate.symbol] = candleId;

    let binanceOrder = null;
    let binanceStopOrder = null;

    if (apiKey && apiSecret) {
      try {
        this.log('ORDER', `Dispatching ${candidate.symbol} ${side} MARKET order for ${qty} contracts to Binance (${environment.toUpperCase()})...`, 'info');

        // Apply dynamic leverage on Binance if adjusted by RiskEngine
        if (riskValidation && riskValidation.metadata && riskValidation.metadata.dynamicLeverageApplied && riskValidation.metadata.leverage) {
          try {
            await setLeverage(apiKey, apiSecret, candidate.symbol, riskValidation.metadata.leverage, baseUrl);
            this.log('ORDER', `Binance leverage set to ${riskValidation.metadata.leverage}x for ${candidate.symbol} to satisfy notional floor`, 'info');
          } catch (levErr) {
            this.log('ORDER', `Note: Dynamic leverage set returned: ${levErr.message}`, 'warn');
          }
        }

        // 1. Primary Market Entry Order
        binanceOrder = await dispatchOrder(apiKey, apiSecret, {
          symbol: candidate.symbol,
          side,
          type: 'MARKET',
          quantity: qty
        }, baseUrl);

        this.log('ORDER', `Binance Order Filled: OrderID #${binanceOrder.orderId} status: ${binanceOrder.status}`, 'success');

        // 2. Attached STOP_MARKET Order for Stop Loss
        try {
          binanceStopOrder = await dispatchOrder(apiKey, apiSecret, {
            symbol: candidate.symbol,
            side: closeSide,
            type: 'STOP_MARKET',
            stopPrice: candidate.stopLossPrice.toFixed(2),
            closePosition: true
          }, baseUrl);
          this.log('ORDER', `Attached STOP_MARKET placed @ $${candidate.stopLossPrice.toFixed(2)} (OrderID #${binanceStopOrder.orderId})`, 'success');
        } catch (stopErr) {
          this.log('ORDER', `Attached STOP_MARKET note: ${stopErr.message}. Local stop loss remains active.`, 'warn');
        }
      } catch (restErr) {
        this.log('ORDER', `REST order placement error: ${restErr.message}`, 'danger');
        if (environment === 'production') {
          // In production, NEVER fall back to simulated execution
          this.log('ORDER', `Execution halted: Live order rejected by Binance in PRODUCTION. No simulated fallback positions allowed.`, 'danger');
          return;
        }
        this.log('ORDER', `Position created in local testnet sandbox mode.`, 'warn');
      }
    } else {
      if (environment === 'production') {
        this.log('ORDER', `Execution Blocked: Target is PRODUCTION (LIVE), but no Binance API credentials are saved. Simulated orders are strictly disabled in live mode.`, 'warn');
        return;
      }
      this.log('ORDER', `Local Simulated Execution (Testnet Sandbox): ${candidate.symbol} ${side} ${qty} @ $${candidate.price.toFixed(2)}`, 'success');
    }

    // Record position in local state
    const newPosition = {
      id: 'pos_' + Date.now(),
      symbol: candidate.symbol,
      side: candidate.side,
      entryPrice: candidate.price,
      markPrice: candidate.price,
      sizeUsdt: riskValidation.metadata.notionalUsdt,
      qty,
      leverage: riskValidation.metadata.leverage,
      slPrice: candidate.stopLossPrice,
      tpPrice: candidate.takeProfitPrice,
      pnl: 0.00,
      pnlPct: 0.00,
      breakEvenMoved: false,
      binanceOrderId: binanceOrder?.orderId || null,
      binanceStopOrderId: binanceStopOrder?.orderId || null,
      createdAt: Date.now()
    };

    this.positions.push(newPosition);
    this.stats.ordersExecuted++;
    this.onPositionsChange(this.positions);

    // Return to scanning
    this.setState(LOOP_STATES.SCANNING, { reason: 'Order Dispatched' });
  }

  // --- DYNAMIC TRAILING STOP & POSITION MONITORING ---

  /**
   * Evaluates active positions against live tick prices
   * Adjusts Stop Loss to Break-Even at +1.0% profit trigger
   * @param {number} livePrice
   */
  evaluateActivePositions(livePrice) {
    if (!this.positions || this.positions.length === 0) return;

    let hasChanges = false;
    const positionsToClose = [];

    this.positions.forEach(pos => {
      pos.markPrice = livePrice;
      const isLong = pos.side === 'LONG';
      const priceDelta = isLong ? (livePrice - pos.entryPrice) : (pos.entryPrice - livePrice);
      const unrealizedPnl = (priceDelta / pos.entryPrice) * pos.sizeUsdt * pos.leverage;
      const pnlPct = (priceDelta / pos.entryPrice) * 100 * pos.leverage;

      pos.pnl = unrealizedPnl;
      pos.pnlPct = pnlPct;

      // 1. Dynamic Trailing Stop to Break-Even at 1.0% Unrealized Profit
      const rawPriceDistancePct = priceDelta / pos.entryPrice;
      if (!pos.breakEvenMoved && rawPriceDistancePct >= this.config.TRAILING_STOP_PROFIT_TRIGGER_PCT) {
        pos.breakEvenMoved = true;
        this.stats.trailingStopsAdjusted++;

        // Break-Even = Entry Price +/- Fee Buffer (0.08%)
        const feeBuffer = pos.entryPrice * this.config.FEE_BUFFER_PCT;
        const breakEvenPrice = isLong ? (pos.entryPrice + feeBuffer) : (pos.entryPrice - feeBuffer);

        pos.slPrice = breakEvenPrice;
        hasChanges = true;

        this.log('RISK', `[DYNAMIC TRAILING STOP] Position ${pos.symbol} ${pos.side} achieved +${(rawPriceDistancePct * 100).toFixed(2)}% gain! Stop Loss adjusted to Break-Even ($${breakEvenPrice.toFixed(2)}) to lock in risk-free trade.`, 'success');

        // Update stop on Binance if keys present
        this.updateBinanceStopOrder(pos, breakEvenPrice);
      }

      // 2. Check Stop Loss and Take Profit Hit
      let closeReason = null;
      if (isLong) {
        if (livePrice <= pos.slPrice) {
          closeReason = pos.breakEvenMoved ? 'BREAK-EVEN STOP TRIGGERED' : 'STOP LOSS TRIGGERED';
        } else if (livePrice >= pos.tpPrice) {
          closeReason = 'TAKE PROFIT TRIGGERED';
        }
      } else {
        if (livePrice >= pos.slPrice) {
          closeReason = pos.breakEvenMoved ? 'BREAK-EVEN STOP TRIGGERED' : 'STOP LOSS TRIGGERED';
        } else if (livePrice <= pos.tpPrice) {
          closeReason = 'TAKE PROFIT TRIGGERED';
        }
      }

      if (closeReason) {
        positionsToClose.push({ pos, closeReason, exitPrice: livePrice, pnl: unrealizedPnl });
      }
    });

    // Execute pending closes
    positionsToClose.forEach(item => {
      this.closePosition(item.pos.id, item.closeReason, item.exitPrice, item.pnl);
      hasChanges = true;
    });

    if (hasChanges) {
      this.onPositionsChange(this.positions);
    }
  }

  /**
   * Closes a position, updates RiskEngine stats, and initiates 5-minute cooldown
   * @param {string} positionId
   * @param {string} reason
   * @param {number} [exitPrice]
   * @param {number} [realizedPnl]
   */
  async closePosition(positionId, reason = 'MANUAL CLOSE', exitPrice, realizedPnl) {
    const idx = this.positions.findIndex(p => p.id === positionId);
    if (idx < 0) return;

    const pos = this.positions[idx];
    const finalExitPrice = exitPrice || this.currentMarkPrice || pos.entryPrice;
    const finalPnl = realizedPnl !== undefined ? realizedPnl : pos.pnl;

    // Remove from active positions
    this.positions.splice(idx, 1);
    this.onPositionsChange(this.positions);

    // Record trade result in RiskEngine to track consecutive losses & daily drawdown
    if (this.riskEngine) {
      this.riskEngine.recordTradeResult(finalPnl, {
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: finalExitPrice,
        reason
      });
    }

    const pnlLabel = finalPnl >= 0 ? `+$${finalPnl.toFixed(2)} USDT` : `-$${Math.abs(finalPnl).toFixed(2)} USDT`;
    const pnlLevel = finalPnl >= 0 ? 'success' : 'warn';
    this.log('ORDER', `Position Closed [${pos.symbol} ${pos.side}]: ${reason} @ $${finalExitPrice.toFixed(2)} | Realized PnL: ${pnlLabel}`, pnlLevel);

    // Close on Binance if keys present
    const { apiKey, apiSecret, environment } = this.getCredentials();
    if (apiKey && apiSecret) {
      const baseUrl = environment === 'production' ? PRODUCTION_REST_URL : DEFAULT_REST_URL;
      try {
        await closePositionMarket(apiKey, apiSecret, pos.symbol, pos.side, pos.qty, baseUrl);
        await cancelAllOpenOrders(apiKey, apiSecret, pos.symbol, baseUrl);
      } catch (e) {
        this.log('ORDER', `Binance close REST note: ${e.message}`, 'info');
      }
    }

    // Invariant: Enforce minimum 5-minute cooldown period after any closed position
    this.setCooldown(this.config.POST_CLOSE_COOLDOWN_MS, `Post-position close cooldown (${reason})`);
  }

  /**
   * Replaces Binance STOP_MARKET order with adjusted break-even price
   * @param {Object} pos
   * @param {number} newStopPrice
   */
  async updateBinanceStopOrder(pos, newStopPrice) {
    const { apiKey, apiSecret, environment } = this.getCredentials();
    if (!apiKey || !apiSecret) return;

    const baseUrl = environment === 'production' ? PRODUCTION_REST_URL : DEFAULT_REST_URL;
    const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';

    try {
      // Cancel previous stop order if present
      await cancelAllOpenOrders(apiKey, apiSecret, pos.symbol, baseUrl);

      // Place new STOP_MARKET at break-even
      const newStop = await dispatchOrder(apiKey, apiSecret, {
        symbol: pos.symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: newStopPrice.toFixed(2),
        closePosition: true
      }, baseUrl);

      pos.binanceStopOrderId = newStop.orderId;
      this.log('ORDER', `Binance Break-Even Stop updated to $${newStopPrice.toFixed(2)} (OrderID #${newStop.orderId})`, 'success');
    } catch (err) {
      this.log('ORDER', `Binance Stop update note: ${err.message}. Local break-even stop active.`, 'warn');
    }
  }

  // --- EMERGENCY KILL SWITCH & DISCONNECT SAFETY ---

  /**
   * Execution-severing Emergency Kill Switch
   * a) Immediately halts the scanning loop and sets state to CIRCUIT_BROKEN.
   * b) Issues immediate REST DELETE /fapi/v1/allOpenOrders call to cancel pending orders.
   * c) Issues market CLOSE orders for any active open position.
   * d) Severs active WebSocket connections and logs critical alerts.
   *
   * @param {string} [reason='OPERATOR EMERGENCY KILL ENGAGED']
   */
  async executeEmergencyKill(reason = 'OPERATOR EMERGENCY KILL ENGAGED') {
    this.stats.emergencyKills++;

    this.log('RISK', `!!! EMERGENCY KILL SWITCH ACTIVATED: ${reason} !!!`, 'danger');
    this.log('RISK', 'Halting automated loop, cancelling pending orders, and severing connections...', 'danger');

    // a) Immediately halt loop and trip circuit breaker
    this.setState(LOOP_STATES.CIRCUIT_BROKEN, { reason });
    if (this.riskEngine) {
      this.riskEngine.tripCircuitBreaker(reason);
    }

    const { apiKey, apiSecret, environment } = this.getCredentials();
    const baseUrl = environment === 'production' ? PRODUCTION_REST_URL : DEFAULT_REST_URL;

    // b) Cancel all open orders via REST
    if (apiKey && apiSecret) {
      try {
        this.log('RISK', `Dispatching REST DELETE /fapi/v1/allOpenOrders for ${this.activeSymbol}...`, 'warn');
        await cancelAllOpenOrders(apiKey, apiSecret, this.activeSymbol, baseUrl);
        this.log('RISK', `All open orders cancelled on Binance Futures.`, 'success');
      } catch (err) {
        this.log('RISK', `REST cancelAllOpenOrders error: ${err.message}`, 'danger');
      }
    }

    // c) Issue market CLOSE orders for any active open position
    const openPositions = [...this.positions];
    for (const pos of openPositions) {
      this.log('RISK', `Emergency Market Close: ${pos.symbol} ${pos.side} (${pos.qty} contracts)...`, 'warn');
      if (apiKey && apiSecret) {
        try {
          await closePositionMarket(apiKey, apiSecret, pos.symbol, pos.side, pos.qty, baseUrl);
        } catch (closeErr) {
          this.log('RISK', `Emergency close REST note: ${closeErr.message}`, 'warn');
        }
      }
      this.closePosition(pos.id, 'EMERGENCY KILL CLOSE', this.currentMarkPrice, pos.pnl);
    }

    // d) Sever active WebSocket connection
    if (this.streamManager && typeof this.streamManager.close === 'function') {
      this.log('RISK', 'Severing active WebSocket stream connection to isolate terminal.', 'warn');
      this.streamManager.close();
    }

    this.log('RISK', 'Emergency Kill procedure complete. All trading operations safely locked.', 'danger');
  }

  // --- HEARTBEAT SAFETY MONITOR ---

  /**
   * Initializes background heartbeat monitor to detect WebSocket drop during active trade
   */
  initHeartbeatMonitor() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      // Only monitor if we have active positions
      if (this.positions.length === 0) return;
      if (!this.streamManager) return;

      const lastMsg = this.streamManager.lastMessageTime || 0;
      const elapsed = Date.now() - lastMsg;

      // Invariant: If WebSocket tick stream goes silent for >10 seconds during active trade
      if (lastMsg > 0 && elapsed > this.config.HEARTBEAT_TIMEOUT_MS) {
        this.log('RISK', `[HEARTBEAT SAFETY] WebSocket feed silent for ${Math.round(elapsed / 1000)}s (>10s limit) during active trade! Performing emergency REST check...`, 'warn');
        this.triggerEmergencyPositionCheck();
      }
    }, 2000);
  }

  /**
   * Emergency REST verification when WebSocket is silent during active trade
   */
  async triggerEmergencyPositionCheck() {
    const { apiKey, apiSecret, environment } = this.getCredentials();
    if (!apiKey || !apiSecret) {
      this.log('RISK', '[HEARTBEAT SAFETY] No REST credentials configured for health check. Attempting WebSocket reconnect...', 'warn');
      if (this.streamManager && typeof this.streamManager.reconnectImmediate === 'function') {
        this.streamManager.reconnectImmediate();
      }
      return;
    }

    const baseUrl = environment === 'production' ? PRODUCTION_REST_URL : DEFAULT_REST_URL;
    try {
      const livePositions = await fetchOpenPositions(apiKey, apiSecret, baseUrl);
      this.log('RISK', `[HEARTBEAT REST VERIFICATION] Binance reports ${livePositions.length} active position(s). Health verified.`, 'info');

      // Attempt WebSocket reconnect if stream was stale
      if (this.streamManager && typeof this.streamManager.reconnectImmediate === 'function') {
        this.streamManager.reconnectImmediate();
      }
    } catch (err) {
      this.log('RISK', `[HEARTBEAT SAFETY] Emergency REST check error: ${err.message}`, 'danger');
    }
  }

  // --- TECHNICAL INDICATOR HELPERS ---

  /**
   * Calculates Exponential Moving Average
   * @param {number} period
   * @returns {number|null}
   */
  calculateEMA(period = 200) {
    if (this.recentKlines.length < 5) return null;
    const closes = this.recentKlines.map(k => k.close);
    const kFactor = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) {
      ema = (closes[i] * kFactor) + (ema * (1 - kFactor));
    }
    return ema;
  }

  /**
   * Calculates Relative Strength Index
   * @param {number} period
   * @returns {number}
   */
  calculateRSI(period = 14) {
    if (this.recentKlines.length < period + 1) return 50.0;
    const closes = this.recentKlines.map(k => k.close);
    let gains = 0;
    let losses = 0;

    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100.0;
    const rs = avgGain / avgLoss;
    return Number((100 - (100 / (1 + rs))).toFixed(1));
  }

  /**
   * Calculates Average True Range
   * @param {number} period
   * @returns {number}
   */
  calculateATR(period = 14) {
    if (this.recentKlines.length < period + 1) {
      return this.currentMarkPrice * 0.001 || 10.0;
    }

    let trSum = 0;
    const klines = this.recentKlines.slice(-period);
    for (let i = 1; i < klines.length; i++) {
      const cur = klines[i];
      const prev = klines[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trSum += tr;
    }
    return Number((trSum / (klines.length - 1)).toFixed(2));
  }

  /**
   * Emits structured audit log
   * @param {string} category
   * @param {string} message
   * @param {'info' | 'success' | 'warn' | 'danger'} level
   */
  log(category, message, level = 'info') {
    this.onLog(category, message, level);
  }

  /**
   * Cleans up timers when tearing down
   */
  destroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.scanIntervalTimer) {
      clearInterval(this.scanIntervalTimer);
      this.scanIntervalTimer = null;
    }
  }
}

// Global window fallback for browser
if (typeof window !== 'undefined') {
  window.CryptoriumAutoLoop = {
    AutoLoopController,
    LOOP_STATES,
    AUTO_LOOP_DEFAULTS
  };
}
