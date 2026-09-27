/**
============================================================
CRYPTORIUM // SERVICES // GEMINI AI MARKET REGIME SUPERVISOR
Phase 4 Quantitative AI Supervisor & Pre-Risk Context Validator
============================================================
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
  ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
  MODEL_NAME: 'gemini-3.8-flash'
});

export class GeminiSupervisor {
  constructor(options = {}) {
    this.endpoint = options.endpoint || SUPERVISOR_DEFAULTS.ENDPOINT;
    this.timeoutMs = Number(options.timeoutMs) || SUPERVISOR_DEFAULTS.TIMEOUT_MS;
    this.confidenceThreshold = typeof options.confidenceThreshold === 'number'
      ? options.confidenceThreshold
      : SUPERVISOR_DEFAULTS.MIN_CONFIDENCE_THRESHOLD;
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.directAiClient = options.directAiClient || null;
    this.apiKey = options.apiKey || '';
    this.lastEvaluation = null;
    this.totalEvaluations = 0;
    this.totalApprovals = 0;
    this.totalVetos = 0;
    this.totalTimeouts = 0;
  }

  async evaluateSignal(inputPayload) {
    const startTime = Date.now();
    this.totalEvaluations++;
    const payload = this.formatPayload(inputPayload);

    if (payload.proposedSignal === PROPOSED_SIGNALS.HOLD) {
      const holdResult = {
        approved: false,
        confidenceScore: 1.0,
        marketRegime: MARKET_REGIMES.CHOPPY_SIDEWAYS,
        reasoning: "AI Supervisor idle: Signal is HOLD. No trade entry requested.",
        latencyMs: 0,
        failSafeTriggered: false
      };
      this._recordResult(holdResult, payload);
      return holdResult;
    }

    const controller = new AbortController();
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        const timeoutErr = new Error('AI Supervisor evaluation timed out');
        timeoutErr.name = 'AbortError';
        reject(timeoutErr);
      }, this.timeoutMs);
    });

    let rawResult = null;
    let failSafeTriggered = false;
    try {
      const evalPromise = (this.directAiClient && typeof this.directAiClient.models?.generateContent === 'function')
        ? this._evaluateDirect(payload, controller.signal)
        : this._evaluateViaHttp(payload, controller.signal);
      rawResult = await Promise.race([evalPromise, timeoutPromise]);
    } catch (err) {
      failSafeTriggered = true;
      const isTimeout = err.name === 'AbortError' || err.message?.includes('aborted') || (Date.now() - startTime >= this.timeoutMs);
      if (isTimeout) {
        this.totalTimeouts++;
        rawResult = {
          approved: false,
          confidenceScore: 0.0,
          marketRegime: MARKET_REGIMES.UNKNOWN_OR_ERROR,
          reasoning: "AI Supervisor offline/timeout - safety veto triggered."
        };
      } else {
        rawResult = {
          approved: false,
          confidenceScore: 0.0,
          marketRegime: MARKET_REGIMES.UNKNOWN_OR_ERROR,
          reasoning: "AI Supervisor offline/timeout - safety veto triggered (" + (err.message || 'Network exception') + ")."
        };
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    const latencyMs = Math.max(1, Date.now() - startTime);
    const normalizedResult = this._normalizeResult(rawResult, latencyMs, failSafeTriggered);
    this._recordResult(normalizedResult, payload);
    return normalizedResult;
  }

  async _evaluateViaHttp(payload, signal) {
    const apiKey = this.apiKey || '';
    const url = this.endpoint + '?key=' + apiKey;
    const promptText = 'Analyze this trade signal and respond with strict JSON: ' + JSON.stringify(payload);

    const body = JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      signal: signal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error('HTTP ' + res.status + ': ' + errText);
    }

    const json = await res.json();
    const text = json.candidates[0].content.parts[0].text;
    if (!text) throw new Error('Empty response from Gemini');
    return JSON.parse(text);
  }

  async _evaluateDirect(payload, signal) {
    const systemInstruction = 'You are the Principal AI Trading Supervisor for Cryptorium, a conservative algorithmic futures trading system dedicated to capital preservation and strict trend alignment. Your Mandate: Inspect incoming trade signals against recent 1-minute candlestick arrays, price action, and indicator metrics. VETO setup signals if the market exhibits choppy sideways action, high volatility whipsaws, major resistance overhead conflicting with trade direction, or lack of volume expansion. Only APPROVE setups when there is clear, high-probability alignment with the dominant short-term regime. Output strict JSON conforming to: { approved: boolean, confidenceScore: number, marketRegime: string, reasoning: string }.';

    const schema = {
      type: 'OBJECT',
      properties: {
        approved: { type: 'BOOLEAN' },
        confidenceScore: { type: 'NUMBER' },
        marketRegime: { type: 'STRING' },
        reasoning: { type: 'STRING' }
      },
      required: ['approved', 'confidenceScore', 'marketRegime', 'reasoning']
    };

    const response = await this.directAiClient.models.generateContent({
      model: SUPERVISOR_DEFAULTS.MODEL_NAME,
      contents: 'Analyze this trade candidate:\n' + JSON.stringify(payload, null, 2),
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.1
      }
    });

    const text = response?.text?.trim();
    if (!text) {
      throw new Error('Empty response from Gemini SDK');
    }
    return JSON.parse(text);
  }

  _normalizeResult(raw, latencyMs, failSafeTriggered) {
    let approved = Boolean(raw && raw.approved);
    const confidenceScore = Math.max(0.0, Math.min(1.0, Number(raw?.confidenceScore) || 0.0));
    let marketRegime = String(raw?.marketRegime || MARKET_REGIMES.UNKNOWN_OR_ERROR);
    let reasoning = String(raw?.reasoning || 'No reasoning provided by supervisor.');

    if (approved && confidenceScore < this.confidenceThreshold) {
      approved = false;
      reasoning = 'AI Supervisor veto: Confidence score (' + (confidenceScore * 100).toFixed(1) + '%) below required ' + (this.confidenceThreshold * 100).toFixed(0) + '% threshold. ' + reasoning;
    }

    return {
      approved,
      confidenceScore: Number(confidenceScore.toFixed(2)),
      marketRegime,
      reasoning,
      latencyMs,
      failSafeTriggered: Boolean(failSafeTriggered)
    };
  }

  formatPayload(input = {}) {
    const symbol = String(input.symbol || 'BTCUSDT').toUpperCase();
    let proposedSignal = String(input.proposedSignal || PROPOSED_SIGNALS.HOLD).toUpperCase();
    if (![PROPOSED_SIGNALS.BUY_LONG, PROPOSED_SIGNALS.SELL_SHORT, PROPOSED_SIGNALS.HOLD].includes(proposedSignal)) {
      proposedSignal = PROPOSED_SIGNALS.HOLD;
    }
    const markPrice = Number(input.markPrice) || 0.0;

    let recentKlines = [];
    if (Array.isArray(input.recentKlines)) {
      recentKlines = input.recentKlines.slice(-15).map(k => {
        if (Array.isArray(k)) {
          return {
            time: k[0] ? new Date(k[0]).toISOString().substring(11, 19) : undefined,
            open: Number(k[1]) || 0,
            high: Number(k[2]) || 0,
            low: Number(k[3]) || 0,
            close: Number(k[4]) || 0,
            volume: Number(k[5]) || 0
          };
        }
        return {
          time: k.time || k.openTime ? new Date(k.time || k.openTime).toISOString().substring(11, 19) : undefined,
          open: Number(k.open) || 0,
          high: Number(k.high) || 0,
          low: Number(k.low) || 0,
          close: Number(k.close) || 0,
          volume: Number(k.volume) || 0
        };
      });
    }

    const indicatorMetrics = input.indicatorMetrics && typeof input.indicatorMetrics === 'object'
      ? { ...input.indicatorMetrics }
      : this.computeDefaultIndicators(recentKlines, markPrice);

    return {
      symbol,
      proposedSignal,
      recentKlines,
      markPrice,
      indicatorMetrics,
      orderBookMetrics: input.orderBookMetrics || null
    };
  }

  computeDefaultIndicators(klines = [], currentPrice = 0) {
    if (!klines || klines.length === 0) {
      return {
        ema200: currentPrice,
        priceVsEmaPct: 0.0,
        rsi14: 50.0,
        atr14: currentPrice * 0.001
      };
    }
    const closes = klines.map(k => k.close).filter(c => c > 0);
    if (closes.length === 0) closes.push(currentPrice);
    const avgClose = closes.reduce((a, b) => a + b, 0) / closes.length;
    const priceVsEmaPct = avgClose > 0 ? ((currentPrice - avgClose) / avgClose) * 100 : 0;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const rs = losses === 0 ? 100 : gains / losses;
    const rsi14 = losses === 0 && gains === 0 ? 50 : 100 - (100 / (1 + rs));
    let totalRange = 0;
    for (const k of klines) {
      totalRange += (k.high - k.low);
    }
    const atr14 = klines.length > 0 ? totalRange / klines.length : currentPrice * 0.001;
    return {
      ema200: Number(avgClose.toFixed(2)),
      priceVsEmaPct: Number(priceVsEmaPct.toFixed(2)),
      rsi14: Number(rsi14.toFixed(1)),
      atr14: Number(atr14.toFixed(2))
    };
  }

  _recordResult(result, payload) {
    this.lastEvaluation = {
      ...result,
      symbol: payload.symbol,
      proposedSignal: payload.proposedSignal,
      timestamp: Date.now()
    };
    if (result.approved) {
      this.totalApprovals++;
    } else {
      this.totalVetos++;
    }
    if (this.logger) {
      const level = result.approved ? 'success' : 'warn';
      const statusTag = result.approved ? 'APPROVED' : 'VETOED';
      const confPct = (result.confidenceScore * 100).toFixed(0) + '%';
      const msg = 'AI Supervisor [' + statusTag + '] ' + payload.symbol + ' ' + payload.proposedSignal + ' | Regime: ' + result.marketRegime + ' | Conf: ' + confPct + ' | Latency: ' + result.latencyMs + 'ms | ' + result.reasoning;
      try {
        this.logger('AI', msg, level);
      } catch (logErr) {
        console.warn('GeminiSupervisor logger callback error:', logErr);
      }
    }
  }

  getTelemetry() {
    return {
      totalEvaluations: this.totalEvaluations,
      totalApprovals: this.totalApprovals,
      totalVetos: this.totalVetos,
      totalTimeouts: this.totalTimeouts,
      approvalRatePct: this.totalEvaluations > 0
        ? Number(((this.totalApprovals / this.totalEvaluations) * 100).toFixed(1))
        : 0.0,
      lastEvaluation: this.lastEvaluation
    };
  }
}
