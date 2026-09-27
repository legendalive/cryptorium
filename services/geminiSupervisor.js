/**
 * ============================================================
 * CRYPTORIUM // SERVICES // GEMINI AI MARKET REGIME SUPERVISOR
 * Phase 4 Quantitative AI Supervisor & Pre-Risk Context Validator
 *
 * Requirements & Invariants:
 *  1. GenAI SDK Integration: Evaluates incoming trade signals against live
 *     candle structures and orderbook metrics using Gemini.
 *  2. Structured JSON Output: Enforces deterministic response format:
 *     { approved: boolean, confidenceScore: number, marketRegime: string, reasoning: string }
 *  3. Confidence Threshold: Require confidenceScore >= 0.80 and approved === true to allow execution.
 *  4. Fail-Safe Veto: If the call times out (>2500ms), errors, or rate limits,
 *     default immediately to: { approved: false, reasoning: "AI Supervisor offline/timeout - safety veto triggered." }
 *  5. Direct Logging: Streams marketRegime, confidenceScore, and reasoning
 *     directly to the audit log pipeline.
 * ============================================================
 */

export const MARKET_REGIMES = Object.freeze({
  BULLISH_TREND: 'BULLISH_TREND',
  BEARISH_TREND: 'BEARISH_TREND',
  CHOPPY_SIDEWAYS: 'CHOPPY_SIDEWAYS',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
  UNKNOWN_OR_ERROR: 'UNKNOWN_OR_ERROR'
});

export const PROPOSED_SIGNALS = Object.freeze({
  BUY_LONG: 'BUY_LONG',
  SELL_SHORT: 'SELL_SHORT',
  HOLD: 'HOLD'
});

export const SUPERVISOR_DEFAULTS = Object.freeze({
  TIMEOUT_MS: 2500,
  MIN_CONFIDENCE_THRESHOLD: 0.80,
  ENDPOINT: '/api/supervisor',
  MODEL_NAME: 'gemini-3.8-flash'
});

export class GeminiSupervisor {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.endpoint='/api/supervisor'] - Base URL for the supervisor evaluation API route
   * @param {number} [options.timeoutMs=2500] - Hard timeout limit before fail-safe veto (default 2500ms)
   * @param {number} [options.confidenceThreshold=0.80] - Minimum confidence required for approval
   * @param {Function|null} [options.logger=null] - Audit logging callback: (category, message, level) => void
   * @param {Object|null} [options.directAiClient=null] - Optional server-side @google/genai client for direct Node.js calls
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint || SUPERVISOR_DEFAULTS.ENDPOINT;
    this.timeoutMs = Number(options.timeoutMs) || SUPERVISOR_DEFAULTS.TIMEOUT_MS;
    this.confidenceThreshold = typeof options.confidenceThreshold === 'number' 
      ? options.confidenceThreshold 
      : SUPERVISOR_DEFAULTS.MIN_CONFIDENCE_THRESHOLD;
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.directAiClient = options.directAiClient || null;

    // Internal telemetry & status tracker
    this.lastEvaluation = null;
    this.totalEvaluations = 0;
    this.totalApprovals = 0;
    this.totalVetos = 0;
    this.totalTimeouts = 0;
  }

  /**
   * Evaluates a trade candidate through the Gemini Market Regime Supervisor.
   * Enforces fail-safe vetoes on timeout (>2500ms), network errors, or low confidence (<0.80).
   *
   * @param {Object} inputPayload
   * @param {string} inputPayload.symbol - Target asset (e.g. "BTCUSDT")
   * @param {string} inputPayload.proposedSignal - "BUY_LONG" | "SELL_SHORT" | "HOLD"
   * @param {Array
