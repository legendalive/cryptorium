/**
 * ============================================================
 * CRYPTORIUM // TEST SUITE // PHASE 5: AUTO-LOOP CONTROLLER
 * Verification of State Machine, Pipeline Flow, Cooldown,
 * Deduplication, Dynamic Trailing Stop, & Emergency Controls
 * ============================================================
 */

import { strict as assert } from 'node:assert';
import {
  AutoLoopController,
  LOOP_STATES,
  AUTO_LOOP_DEFAULTS
} from './autoLoopController.js';

async function runTests() {
  console.log('=== RUNNING PHASE 5 AUTO-LOOP CONTROLLER TESTS ===');

  let logMessages = [];
  const captureLogger = (cat, msg, lvl) => {
    logMessages.push({ cat, msg, lvl });
  };

  // Mock RiskEngine
  const mockRiskEngine = {
    validateOrder: (candidate) => {
      if (candidate.price <= 0) {
        return { approved: false, reason: 'Invalid mark price' };
      }
      return {
        approved: true,
        adjustedQty: 0.0003,
        metadata: {
          notionalUsdt: 20.00,
          leverage: 1,
          capitalRiskUsdt: 0.16,
          liquidationPrice: 32000.00
        }
      };
    },
    recordTradeResult: (pnl) => {},
    isCircuitBreakerTripped: () => false,
    tripCircuitBreaker: (reason) => {},
    resetCircuitBreaker: (reason) => {}
  };

  // Mock GeminiSupervisor
  const mockGeminiSupervisor = {
    evaluateSignal: async (payload) => {
      return {
        approved: true,
        confidenceScore: 0.88,
        marketRegime: 'BULLISH_TREND',
        reasoning: 'Strong 1m trend alignment above 200 EMA with safe RSI bounce.',
        latencyMs: 140,
        failSafeTriggered: false
      };
    }
  };

  // Mock StreamManager
  let streamClosed = false;
  let streamReconnected = false;
  const mockStreamManager = {
    lastMessageTime: Date.now(),
    close: () => { streamClosed = true; },
    reconnectImmediate: () => { streamReconnected = true; }
  };

  // --- TEST 1: State Machine Transitions ---
  {
    const controller = new AutoLoopController({
      riskEngine: mockRiskEngine,
      geminiSupervisor: mockGeminiSupervisor,
      streamManager: mockStreamManager,
      onLog: captureLogger
    });

    assert.equal(controller.getState(), LOOP_STATES.IDLE);
    controller.start('BTCUSDT');
    assert.equal(controller.getState(), LOOP_STATES.SCANNING);
    controller.stop();
    assert.equal(controller.getState(), LOOP_STATES.IDLE);
    console.log('✅ PASS: State machine transitions (IDLE -> SCANNING -> IDLE) verified');
    controller.destroy();
  }

  // --- TEST 2: Signal Deduplication on Same 1m Candle ---
  {
    const controller = new AutoLoopController({
      riskEngine: mockRiskEngine,
      geminiSupervisor: mockGeminiSupervisor,
      streamManager: mockStreamManager,
      onLog: captureLogger
    });

    controller.start('BTCUSDT');
    const candleTime = 1700000000000;

    // First kline on candle
    const kline1 = {
      symbol: 'BTCUSDT',
      startTime: candleTime,
      close: 65500.00,
      high: 65600.00,
      low: 65400.00
    };

    await controller.evaluatePipelineTick(kline1);
    assert.equal(controller.stats.ordersExecuted, 1, 'First tick on candle should execute order');

    // Duplicate kline tick on same candle interval
    const kline2 = {
      symbol: 'BTCUSDT',
      startTime: candleTime,
      close: 65550.00,
      high: 65620.00,
      low: 65400.00
    };

    await controller.evaluatePipelineTick(kline2);
    assert.equal(controller.stats.ordersExecuted, 1, 'Duplicate tick on same candle must be deduplicated');
    console.log('✅ PASS: Signal deduplication on same candlestick interval enforced');
    controller.destroy();
  }

  // --- TEST 3: Full Pipeline Flow (Scan -> Risk -> Gemini -> Order) ---
  {
    let orderDispatched = false;
    const testRiskEngine = {
      ...mockRiskEngine,
      validateOrder: (cand) => {
        return {
          approved: true,
          adjustedQty: 0.000305,
          metadata: { notionalUsdt: 20.00, leverage: 1 }
        };
      }
    };

    const controller = new AutoLoopController({
      riskEngine: testRiskEngine,
      geminiSupervisor: mockGeminiSupervisor,
      streamManager: mockStreamManager,
      onLog: captureLogger,
      onPositionsChange: (positions) => {
        if (positions.length > 0) orderDispatched = true;
      }
    });

    controller.start('BTCUSDT');
    const kline = {
      symbol: 'BTCUSDT',
      startTime: 1700000060000,
      close: 65600.00,
      high: 65700.00,
      low: 65500.00
    };

    await controller.evaluatePipelineTick(kline);
    assert.equal(orderDispatched, true, 'Order must be dispatched and position created');
    assert.equal(controller.positions.length, 1);
    assert.equal(controller.positions[0].symbol, 'BTCUSDT');
    assert.equal(controller.positions[0].breakEvenMoved, false);
    console.log('✅ PASS: Continuous Pipeline Flow (Scan -> Risk -> Gemini -> Executed) verified');
    controller.destroy();
  }

  // --- TEST 4: Dynamic Trailing Stop to Break-Even at +1.0% Profit ---
  {
    const controller = new AutoLoopController({
      riskEngine: mockRiskEngine,
      geminiSupervisor: mockGeminiSupervisor,
      streamManager: mockStreamManager,
      onLog: captureLogger
    });

    const entryPrice = 60000.00;
    const initialSl = 60000.00 * (1 - 0.008); // 59520.00

    controller.positions.push({
      id: 'test_pos_1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice,
      markPrice: entryPrice,
      sizeUsdt: 20.00,
      qty: 0.000333,
      leverage: 1,
      slPrice: initialSl,
      tpPrice: 60000.00 * (1 + 0.014),
      pnl: 0,
      pnlPct: 0,
      breakEvenMoved: false
    });

    // 1. Price increases by +0.8% (below 1.2% trigger)
    controller.evaluateActivePositions(60480.00);
    assert.equal(controller.positions[0].breakEvenMoved, false);
    assert.equal(controller.positions[0].slPrice, initialSl);

    // 2. Price reaches +1.2% profit (60720.00)
    controller.evaluateActivePositions(60720.00);
    assert.equal(controller.positions[0].breakEvenMoved, true);

    // Break-even price should be entryPrice + fee buffer (60000 + 60 = 60060.00)
    const expectedBreakEven = 60000.00 * (1 + AUTO_LOOP_DEFAULTS.FEE_BUFFER_PCT);
    assert.ok(Math.abs(controller.positions[0].slPrice - expectedBreakEven) < 0.01, 'Break-even price should match expected');
    assert.equal(controller.stats.trailingStopsAdjusted, 1);
    console.log('✅ PASS: Dynamic Trailing Stop adjusts Stop Loss to Break-Even at +1.2% gain');
    controller.destroy();
  }

  // --- TEST 5: 5-Minute Cooldown Enforced After Position Close ---
  {
    const controller = new AutoLoopController({
      riskEngine: mockRiskEngine,
      geminiSupervisor: mockGeminiSupervisor,
      streamManager: mockStreamManager,
      onLog: captureLogger
    });

    controller.positions.push({
      id: 'test_pos_2',
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice: 60000.00,
      markPrice: 60000.00,
      sizeUsdt: 20.00,
      qty: 0.000333,
      leverage: 1,
      slPrice: 59500.00,
      tpPrice: 61000.00,
      pnl: 0.20,
      pnlPct: 1.0,
      breakEvenMoved: false
    });

    assert.equal(controller.inCooldown(), false);
    await controller.closePosition('test_pos_2', 'TARGET REACHED', 60600.00, 0.20);

    assert.equal(controller.positions.length, 0);
    assert.equal(controller.inCooldown(), true, 'Controller must be in cooldown after position close');
    assert.equal(controller.getState(), LOOP_STATES.COOLDOWN);
    const remainingMs = controller.cooldownUntil - Date.now();
    assert.ok(remainingMs >= (4.9 * 60 * 1000), 'Cooldown must be >= ~5 minutes');
    console.log('✅ PASS: 5-minute cooldown period strictly enforced after position close');
    controller.destroy();
  }

  // --- TEST 6: Emergency Kill Switch Disconnect & Position Severing ---
  {
    streamClosed = false;
    let circuitTripped = false;
    const testRiskEngine = {
      ...mockRiskEngine,
      tripCircuitBreaker: (reason) => { circuitTripped = true; }
    };

    const controller = new AutoLoopController({
      riskEngine: testRiskEngine,
      geminiSupervisor: mockGeminiSupervisor,
      streamManager: mockStreamManager,
      onLog: captureLogger
    });

    controller.start('BTCUSDT');
    controller.positions.push({
      id: 'pos_kill_test',
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice: 65000.00,
      markPrice: 65000.00,
      sizeUsdt: 20.00,
      qty: 0.0003,
      leverage: 1,
      slPrice: 64500.00,
      tpPrice: 66000.00,
      pnl: 0,
      pnlPct: 0
    });

    await controller.executeEmergencyKill('OPERATOR MANUAL KILL');

    assert.equal(controller.getState(), LOOP_STATES.CIRCUIT_BROKEN, 'State must transition to CIRCUIT_BROKEN');
    assert.equal(circuitTripped, true, 'Risk Engine circuit breaker must be tripped');
    assert.equal(controller.positions.length, 0, 'All open positions must be closed immediately');
    assert.equal(streamClosed, true, 'WebSocket connection must be severed');
    assert.equal(controller.stats.emergencyKills, 1);
    console.log('✅ PASS: Emergency Kill Switch halts loop, closes positions, and severs WebSocket connection');
    controller.destroy();
  }

  // --- TEST 7: Heartbeat Safety Monitor on Stream Silence ---
  {
    streamReconnected = false;
    const controller = new AutoLoopController({
      riskEngine: mockRiskEngine,
      geminiSupervisor: mockGeminiSupervisor,
      streamManager: {
        lastMessageTime: Date.now() - 15000, // 15 seconds silent (>10s limit)
        reconnectImmediate: () => { streamReconnected = true; },
        close: () => {}
      },
      onLog: captureLogger
    });

    // Add active position so heartbeat is active
    controller.positions.push({
      id: 'pos_hb',
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice: 65000,
      markPrice: 65000,
      sizeUsdt: 20
    });

    await controller.triggerEmergencyPositionCheck();
    assert.equal(streamReconnected, true, 'Heartbeat safety must trigger emergency reconnect on silent feed');
    console.log('✅ PASS: Heartbeat Safety Monitor triggers emergency recovery when WebSocket feed is silent >10s');
    controller.destroy();
  }

  console.log('=== ALL PHASE 5 AUTO-LOOP CONTROLLER TESTS PASSED ===');
}

runTests().catch(err => {
  console.error('Test failure:', err);
  process.exit(1);
});
