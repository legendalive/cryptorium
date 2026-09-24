import assert from 'node:assert/strict';
import {
  GeminiSupervisor,
  MARKET_REGIMES,
  PROPOSED_SIGNALS,
  SUPERVISOR_DEFAULTS
} from './geminiSupervisor.js';

console.log('=== RUNNING PHASE 4 GEMINI SUPERVISOR SPECIFICATION TESTS ===');

// Mock 15-candle 1-minute historical array
const sampleKlines = Array.from({ length: 15 }, (_, i) => ({
  time: Date.now() - (15 - i) * 60000,
  open: 65000 + i * 20,
  high: 65030 + i * 20,
  low: 64990 + i * 20,
  close: 65020 + i * 20,
  volume: 12.5 + i * 0.5
}));

// Test 1: Payload formatting
{
  const supervisor = new GeminiSupervisor();
  const formatted = supervisor.formatPayload({
    symbol: 'btcusdt',
    proposedSignal: 'buy_long',
    recentKlines: sampleKlines,
    markPrice: 65350.00
  });

  assert.equal(formatted.symbol, 'BTCUSDT');
  assert.equal(formatted.proposedSignal, 'BUY_LONG');
  assert.equal(formatted.markPrice, 65350.00);
  assert.equal(formatted.recentKlines.length, 15);
  assert(formatted.indicatorMetrics.ema200 > 0);
  assert(formatted.indicatorMetrics.rsi14 >= 0 && formatted.indicatorMetrics.rsi14 <= 100);
  console.log('✅ PASS: Input payload formatting & default indicator calculations verified');
}

// Test 2: HOLD signal returns immediate non-entry response
{
  const supervisor = new GeminiSupervisor();
  const result = await supervisor.evaluateSignal({
    symbol: 'BTCUSDT',
    proposedSignal: 'HOLD',
    recentKlines: sampleKlines,
    markPrice: 65350.00
  });

  assert.equal(result.approved, false);
  assert.equal(result.marketRegime, MARKET_REGIMES.CHOPPY_SIDEWAYS);
  assert(result.reasoning.includes('Signal is HOLD'));
  console.log('✅ PASS: Proposed HOLD signal immediately vetoes trade entry safely');
}

// Test 3: Approved candidate with high confidence (>= 0.80)
{
  const logs = [];
  const mockAiClient = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          approved: true,
          confidenceScore: 0.88,
          marketRegime: 'BULLISH_TREND',
          reasoning: 'Strong bullish breakout above 200 EMA with volume confirmation.'
        })
      })
    }
  };

  const supervisor = new GeminiSupervisor({
    directAiClient: mockAiClient,
    logger: (cat, msg, lvl) => logs.push({ cat, msg, lvl })
  });

  const result = await supervisor.evaluateSignal({
    symbol: 'BTCUSDT',
    proposedSignal: 'BUY_LONG',
    recentKlines: sampleKlines,
    markPrice: 65350.00
  });

  assert.equal(result.approved, true);
  assert.equal(result.confidenceScore, 0.88);
  assert.equal(result.marketRegime, 'BULLISH_TREND');
  assert.equal(result.failSafeTriggered, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].cat, 'AI');
  assert(logs[0].msg.includes('[APPROVED]'));
  console.log('✅ PASS: High-confidence signal approved with structured output & audit logging');
}

// Test 4: Low-confidence veto enforcement (< 0.80 threshold)
{
  const mockAiClient = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          approved: true, // Model returned true, but confidence is only 0.72
          confidenceScore: 0.72,
          marketRegime: 'BULLISH_TREND',
          reasoning: 'Moderate trend but momentum slowing.'
        })
      })
    }
  };

  const supervisor = new GeminiSupervisor({ directAiClient: mockAiClient });
  const result = await supervisor.evaluateSignal({
    symbol: 'BTCUSDT',
    proposedSignal: 'BUY_LONG',
    recentKlines: sampleKlines,
    markPrice: 65350.00
  });

  assert.equal(result.approved, false, 'Should override approved to false when confidence < 0.80');
  assert.equal(result.confidenceScore, 0.72);
  assert(result.reasoning.includes('below required 80% threshold'));
  console.log('✅ PASS: Low-confidence (<0.80) setup overridden to veto per capital preservation invariant');
}

// Test 5: Strict timeout (>2500ms) triggers fail-safe safety veto
{
  const mockAiClient = {
    models: {
      generateContent: async () => {
        // Hang longer than timeout limit (3000ms > 200ms test limit)
        await new Promise(r => setTimeout(r, 300));
        return { text: '{}' };
      }
    }
  };

  const supervisor = new GeminiSupervisor({
    directAiClient: mockAiClient,
    timeoutMs: 100 // Test with 100ms timeout
  });

  const result = await supervisor.evaluateSignal({
    symbol: 'BTCUSDT',
    proposedSignal: 'BUY_LONG',
    recentKlines: sampleKlines,
    markPrice: 65350.00
  });

  assert.equal(result.approved, false);
  assert.equal(result.failSafeTriggered, true);
  assert(result.reasoning.includes('AI Supervisor offline/timeout - safety veto triggered'));
  console.log('✅ PASS: Timeout triggers immediate fail-safe safety veto without stalling pipeline');
}

// Test 6: Network / API exception triggers fail-safe safety veto
{
  const mockAiClient = {
    models: {
      generateContent: async () => {
        throw new Error('API 429 ResourceExhausted');
      }
    }
  };

  const supervisor = new GeminiSupervisor({ directAiClient: mockAiClient });
  const result = await supervisor.evaluateSignal({
    symbol: 'BTCUSDT',
    proposedSignal: 'SELL_SHORT',
    recentKlines: sampleKlines,
    markPrice: 65350.00
  });

  assert.equal(result.approved, false);
  assert.equal(result.failSafeTriggered, true);
  assert(result.reasoning.includes('safety veto triggered'));
  console.log('✅ PASS: API error / 429 rate limit triggers fail-safe safety veto');
}

// Test 7: Telemetry counters
{
  const mockAiClient = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          approved: true,
          confidenceScore: 0.95,
          marketRegime: 'BULLISH_TREND',
          reasoning: 'Confirmed clean breakout.'
        })
      })
    }
  };

  const supervisor = new GeminiSupervisor({ directAiClient: mockAiClient });
  await supervisor.evaluateSignal({ symbol: 'BTCUSDT', proposedSignal: 'BUY_LONG', markPrice: 65000 });
  await supervisor.evaluateSignal({ symbol: 'BTCUSDT', proposedSignal: 'HOLD', markPrice: 65000 });

  const telemetry = supervisor.getTelemetry();
  assert.equal(telemetry.totalEvaluations, 2);
  assert.equal(telemetry.totalApprovals, 1);
  assert.equal(telemetry.totalVetos, 1);
  console.log('✅ PASS: Supervisor telemetry tracking confirmed');
}

console.log('=== ALL PHASE 4 GEMINI SUPERVISOR TESTS PASSED ===');
