import { RiskEngine } from './riskEngine.js';
import { DatabaseSync } from 'node:sqlite';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    passed++;
    console.log(`✅ PASS: ${message}`);
  }
}

console.log('=== RUNNING PHASE 3 RISK ENGINE SPECIFICATION TESTS ===\n');

// 1. In-memory SQLite Database
const db = new DatabaseSync(':memory:');

// 2. Mock Local Store with fresh data
const store = {
  walletBalance: 100.0,
  balanceTimestamp: Date.now(),
  unrealizedPnl: 0.0,
  currentMarkPrice: 65000.0,
  markPriceTimestamp: Date.now(),
  positions: [],
  pendingOrders: [{ id: 'order_1', symbol: 'BTCUSDT' }],
  startingDailyEquity: 100.0,
  tradingHalted: false,
  haltReason: null,

  getBalanceData() {
    return {
      walletBalance: this.walletBalance,
      unrealizedPnl: this.unrealizedPnl,
      timestamp: this.balanceTimestamp
    };
  },
  getMarkPriceData(symbol) {
    return {
      price: this.currentMarkPrice,
      timestamp: this.markPriceTimestamp
    };
  },
  getOpenPositions() {
    return this.positions;
  },
  cancelPendingOrders() {
    this.pendingOrders = [];
  },
  setTradingHalted(halted, reason) {
    this.tradingHalted = halted;
    this.haltReason = reason;
  },
  getStartingDailyEquity() {
    return this.startingDailyEquity;
  }
};

const riskEngine = new RiskEngine(db, store, {
  maxRiskPerTradePct: 0.01,
  maxLeverage: 2,
  maxDailyDrawdownPct: 0.03,
  maxConsecutiveLosses: 3,
  consecutiveLossCooldownMs: 2 * 60 * 60 * 1000,
  minLiquidationDistancePct: 0.02,
  maxOrdersPerSecond: 5,
  maxOrdersPerMinute: 50,
  maxStalenessMs: 5000,
  maxPositionNotionalUsdt: 20.0
});

// TEST 1: Synchronous Validation Speed (< 1ms)
// Warm up JIT execution
riskEngine.validateOrder({ symbol: 'BTCUSDT', side: 'LONG', leverage: 2, price: 65000.0, stopLossPrice: 64480.0 });

const t0 = performance.now();
const res1 = riskEngine.validateOrder({
  symbol: 'BTCUSDT',
  side: 'LONG',
  leverage: 2,
  price: 65000.0,
  stopLossPrice: 64480.0 // 0.8% SL
});
const dt = performance.now() - t0;
assert(res1.approved === true, 'Valid order approved');
assert(dt < 1.0, `Synchronous validation runs in < 1ms (took ${dt.toFixed(3)}ms)`);
assert(res1.adjustedQty > 0, `Adjusted quantity computed: ${res1.adjustedQty}`);
assert(res1.metadata.capitalRiskPct <= 1.05, `Risk strictly bounded within 1% capital risk limit: ${res1.metadata.capitalRiskPct}%`);

// TEST 2: Fail-Closed Architecture on Stale Mark Price (> 5000ms)
store.markPriceTimestamp = Date.now() - 5500; // 5.5 seconds ago
const resStalePrice = riskEngine.validateOrder({
  symbol: 'BTCUSDT',
  side: 'LONG',
  leverage: 2
});
assert(resStalePrice.approved === false, 'Stale mark price rejected');
assert(resStalePrice.reason.includes('stale'), `Rejection reason states mark price stale: ${resStalePrice.reason}`);
store.markPriceTimestamp = Date.now(); // Restore

// TEST 3: Fail-Closed Architecture on Stale Balance (> 5000ms)
store.balanceTimestamp = Date.now() - 6000;
const resStaleBalance = riskEngine.validateOrder({
  symbol: 'BTCUSDT',
  side: 'LONG',
  leverage: 2
});
assert(resStaleBalance.approved === false, 'Stale balance rejected');
assert(resStaleBalance.reason.includes('stale'), `Rejection reason states balance stale: ${resStaleBalance.reason}`);
store.balanceTimestamp = Date.now(); // Restore

// TEST 4: Leverage Ceiling Enforcement (Reject if leverage > ceiling)
const resHighLev = riskEngine.validateOrder({
  symbol: 'BTCUSDT',
  side: 'LONG',
  leverage: 10 // exceeds ceiling of 2x
});
assert(resHighLev.approved === false, 'Excessive leverage rejected');
assert(resHighLev.reason.includes('Leverage violation'), `Rejection reason cites leverage ceiling: ${resHighLev.reason}`);

// TEST 5: Liquidation Buffer Check (< 2% safe distance)
// If maintenance margin rate is high or extreme leverage creates < 2% distance
const extremeEngine = new RiskEngine(null, store, {
  maxLeverage: 100,
  minLiquidationDistancePct: 0.05, // Require 5% distance
  maintenanceMarginRate: 0.03
});
const resLiqRisk = extremeEngine.validateOrder({
  symbol: 'BTCUSDT',
  side: 'LONG',
  leverage: 50 // 1/50 = 0.02, distance = 0.02 - 0.03 < 0
});
assert(resLiqRisk.approved === false, 'Liquidation buffer breach rejected');
assert(resLiqRisk.reason.includes('Liquidation buffer violation'), `Rejection notes liquidation buffer: ${resLiqRisk.reason}`);

// TEST 6: Rate Limiting (Max 5 orders/sec)
const rateEngine = new RiskEngine(null, store, { maxOrdersPerSecond: 5 });
let rateLimitHit = false;
for (let i = 0; i < 7; i++) {
  const r = rateEngine.validateOrder({
    symbol: 'BTCUSDT',
    side: 'LONG',
    leverage: 1
  });
  if (!r.approved && r.reason.includes('Rate limit breach')) {
    rateLimitHit = true;
    break;
  }
}
assert(rateLimitHit === true, 'Rate limiter actively throttles when frequency > 5 orders/sec');

// TEST 7: Consecutive Loss Limiter (3 consecutive losses -> 2-hour cooldown)
const lossDb = new DatabaseSync(':memory:');
const lossEngine = new RiskEngine(lossDb, store, {
  maxConsecutiveLosses: 3,
  consecutiveLossCooldownMs: 7200000
});

lossEngine.recordTradeResult({ id: 't1', symbol: 'BTCUSDT', side: 'LONG', entryPrice: 65000, exitPrice: 64500, qty: 0.001, realizedPnl: -0.50 });
lossEngine.recordTradeResult({ id: 't2', symbol: 'BTCUSDT', side: 'LONG', entryPrice: 65000, exitPrice: 64500, qty: 0.001, realizedPnl: -0.60 });
assert(lossEngine.checkCircuitBreakers().cooldownActive === false, 'Cooldown inactive after 2 losses');

const resLoss3 = lossEngine.recordTradeResult({ id: 't3', symbol: 'BTCUSDT', side: 'LONG', entryPrice: 65000, exitPrice: 64500, qty: 0.001, realizedPnl: -0.70 });
assert(resLoss3.cooldownTriggered === true, 'Cooldown triggered on 3rd consecutive loss');
assert(lossEngine.checkCircuitBreakers().cooldownActive === true, 'Circuit breaker reports cooldown active');

const blockedOrder = lossEngine.validateOrder({ symbol: 'BTCUSDT', side: 'LONG', leverage: 1 });
assert(blockedOrder.approved === false, 'Order blocked during consecutive loss cooldown');
assert(blockedOrder.reason.includes('Consecutive loss cooldown active'), `Blocked reason: ${blockedOrder.reason}`);

// TEST 8: Daily Drawdown Circuit Breaker (-3% Max Daily Drawdown)
const ddStore = {
  walletBalance: 96.5, // 100 -> 96.5 is -3.5% drawdown
  unrealizedPnl: 0.0,
  balanceTimestamp: Date.now(),
  currentMarkPrice: 65000.0,
  markPriceTimestamp: Date.now(),
  startingDailyEquity: 100.0,
  positions: [],
  pendingOrders: [{ id: 'pending_1' }],
  cancelPendingOrders() {
    this.pendingOrders = [];
  },
  getBalanceData() {
    return { walletBalance: this.walletBalance, unrealizedPnl: this.unrealizedPnl, timestamp: this.balanceTimestamp };
  },
  getMarkPriceData() {
    return { price: this.currentMarkPrice, timestamp: this.markPriceTimestamp };
  },
  getStartingDailyEquity() {
    return this.startingDailyEquity;
  }
};

const ddEngine = new RiskEngine(null, ddStore, {
  maxDailyDrawdownPct: 0.03 // 3% max
});

const ddCheck = ddEngine.checkCircuitBreakers();
assert(ddCheck.dailyDrawdownBreached === true, 'Daily drawdown breach detected (-3.5% vs -3.0% threshold)');
assert(ddEngine.tradingHalted === true, 'Trading halted globally on daily drawdown breach');
assert(ddStore.pendingOrders.length === 0, 'Open pending orders cancelled upon daily drawdown breach');

const ddBlockedOrder = ddEngine.validateOrder({ symbol: 'BTCUSDT', side: 'LONG', leverage: 1 });
assert(ddBlockedOrder.approved === false, 'New order blocked when daily drawdown breached');
assert(ddBlockedOrder.reason.includes('HALTED'), `Rejection message indicates trading halted: ${ddBlockedOrder.reason}`);

// TEST 24: Small Balance (<10 USDT) Dynamic Leverage Bump on BTCUSDT to pass 50 USDT floor
const smallBalanceStore = {
  walletBalance: 8.50, // $8.50 USDT small balance
  unrealizedPnl: 0,
  balanceTimestamp: Date.now(),
  currentMarkPrice: 65000.0,
  markPriceTimestamp: Date.now(),
  openPositions: [],
  getBalanceData() {
    return { walletBalance: this.walletBalance, unrealizedPnl: this.unrealizedPnl, timestamp: this.balanceTimestamp };
  },
  getMarkPriceData(sym) {
    if (sym === 'XRPUSDT') return { price: 2.10, timestamp: this.markPriceTimestamp };
    return { price: this.currentMarkPrice, timestamp: this.markPriceTimestamp };
  },
  getOpenPositions() {
    return this.openPositions;
  },
  getStartingDailyEquity() {
    return this.walletBalance;
  },
  cancelPendingOrders() {}
};

const smallBalanceEngine = new RiskEngine(null, smallBalanceStore, {
  enableDynamicBtcLeverageBump: true,
  smallBalanceMaxBtcLeverage: 10,
  btcMinNotionalFloorUsdt: 50.00
});

// Candidate asks for 1x leverage on BTCUSDT with $8.50 capital
const resBtcSmall = smallBalanceEngine.validateOrder({
  symbol: 'BTCUSDT',
  side: 'BUY',
  leverage: 1,
  price: 65000.0,
  stopLossPrice: 64480.0
});

assert(resBtcSmall.approved === true, 'Small balance ($8.50) approved for BTCUSDT via dynamic leverage bump');
assert(resBtcSmall.metadata.dynamicLeverageApplied === true, 'Dynamic leverage bump flagged as applied');
assert(resBtcSmall.metadata.leverage >= 6, `Dynamic leverage bumped to ${resBtcSmall.metadata.leverage}x (>= 6x) to pass 50 USDT floor`);
assert(resBtcSmall.metadata.notionalUsdt >= 50.00, `Notional ($${resBtcSmall.metadata.notionalUsdt}) passes the 50 USDT exchange floor`);
assert(resBtcSmall.adjustedQty >= 0.001, `Quantity (${resBtcSmall.adjustedQty}) satisfies 0.001 BTC step size`);

// TEST 25: Smart Pair Routing for Small Balances (<10 USDT) to XRPUSDT
const routeCheck = smallBalanceEngine.suggestOrRoutePair('BTCUSDT', 8.50, 65000.0);
assert(routeCheck.shouldRoute === true, 'Small balance (< 10 USDT) flagged for automatic altcoin routing');
assert(routeCheck.recommendedSymbol === 'XRPUSDT', `Recommended symbol is XRPUSDT (received: ${routeCheck.recommendedSymbol})`);

// Candidate opting for altcoin auto-routing
const resAltRoute = smallBalanceEngine.validateOrder({
  symbol: 'BTCUSDT',
  side: 'BUY',
  leverage: 1,
  autoRouteAltcoin: true
});

assert(resAltRoute.approved === true, 'Small balance order approved when routed to altcoin');
assert(resAltRoute.metadata.routedToAltcoin === true, 'Order flagged as routed to altcoin');
assert(resAltRoute.metadata.symbol === 'XRPUSDT', 'Order executed symbol switched to XRPUSDT');
assert(resAltRoute.metadata.notionalUsdt >= 5.00, `XRPUSDT order ($${resAltRoute.metadata.notionalUsdt}) satisfies $5.00 min notional floor`);

console.log(`\n=== ALL TESTS PASSED: ${passed}/${passed + failed} ===\n`);
