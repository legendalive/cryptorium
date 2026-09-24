import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response Schema for Gemini Structured Output
const SUPERVISOR_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    approved: {
      type: Type.BOOLEAN,
      description: "Whether the proposed signal is approved for execution.",
    },
    confidenceScore: {
      type: Type.NUMBER,
      description: "Confidence rating between 0.00 and 1.00.",
    },
    marketRegime: {
      type: Type.STRING,
      description: "e.g., BULLISH_TREND, BEARISH_TREND, CHOPPY_SIDEWAYS, HIGH_VOLATILITY",
    },
    reasoning: {
      type: Type.STRING,
      description: "Concise 1-2 sentence explanation of the decision.",
    },
  },
  required: ["approved", "confidenceScore", "marketRegime", "reasoning"],
};

const SYSTEM_INSTRUCTION = `You are the Principal AI Trading Supervisor for Cryptorium, a conservative algorithmic futures trading system dedicated to capital preservation and strict trend alignment.

Your Mandate:
- Act as a high-level context validator inspecting incoming trade signals against recent 1-minute candlestick arrays, price action, and indicator metrics.
- Enforce strict capital preservation: VETO setup signals if the market exhibits choppy sideways action, high volatility whipsaws, major resistance/support overhead conflicting with the trade direction, or lack of volume expansion.
- Only APPROVE setups when there is clear, high-probability alignment with the dominant short-term regime (e.g., BUY_LONG in a confirmed BULLISH_TREND above 200 EMA with RSI between 45-65; SELL_SHORT in a confirmed BEARISH_TREND below 200 EMA with RSI between 35-55).
- If the proposed signal is HOLD, market is sideways, or signal lacks edge, set approved to false.
- You must output strict JSON conforming to the response schema with fields: approved, confidenceScore (0.00 to 1.00), marketRegime (BULLISH_TREND, BEARISH_TREND, CHOPPY_SIDEWAYS, or HIGH_VOLATILITY), and reasoning.`;

let genAiClient: GoogleGenAI | null = null;

function getGenAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!genAiClient) {
    genAiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return genAiClient;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { symbol, proposedSignal, recentKlines, markPrice, indicatorMetrics, orderBookMetrics } = body;

    // Fail-Safe Veto if no API key is available
    const ai = getGenAiClient();
    if (!ai) {
      return NextResponse.json({
        approved: false,
        confidenceScore: 0.0,
        marketRegime: "UNKNOWN_OR_ERROR",
        reasoning: "AI Supervisor offline/timeout - safety veto triggered (GEMINI_API_KEY unavailable).",
      });
    }

    // Prepare prompt contents
    const promptPayload = {
      symbol: symbol || "BTCUSDT",
      proposedSignal: proposedSignal || "HOLD",
      markPrice: Number(markPrice) || 0,
      indicatorMetrics: indicatorMetrics || {},
      orderBookMetrics: orderBookMetrics || null,
      recentKlines: Array.isArray(recentKlines)
        ? recentKlines.slice(-15).map((k: any) => ({
            time: k.openTime || k.time || undefined,
            open: Number(k.open),
            high: Number(k.high),
            low: Number(k.low),
            close: Number(k.close),
            volume: Number(k.volume),
          }))
        : [],
    };

    // Server-side strict timeout budget: 2300ms race
    const timeoutPromise = new Promise<{ timeout: true }>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 2300)
    );

    const evaluationPromise = ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: `Perform Market Regime Supervision on this trade candidate:\n${JSON.stringify(promptPayload, null, 2)}`,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: SUPERVISOR_RESPONSE_SCHEMA,
        temperature: 0.1, // Deterministic, conservative classification
      },
    });

    const raceResult = await Promise.race([evaluationPromise, timeoutPromise]);

    if ("timeout" in raceResult) {
      return NextResponse.json({
        approved: false,
        confidenceScore: 0.0,
        marketRegime: "UNKNOWN_OR_ERROR",
        reasoning: "AI Supervisor offline/timeout - safety veto triggered.",
      });
    }

    const responseText = raceResult.text?.trim();
    if (!responseText) {
      return NextResponse.json({
        approved: false,
        confidenceScore: 0.0,
        marketRegime: "UNKNOWN_OR_ERROR",
        reasoning: "AI Supervisor offline/timeout - safety veto triggered (empty response).",
      });
    }

    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch {
      return NextResponse.json({
        approved: false,
        confidenceScore: 0.0,
        marketRegime: "UNKNOWN_OR_ERROR",
        reasoning: "AI Supervisor offline/timeout - safety veto triggered (parse failure).",
      });
    }

    const approved = Boolean(parsedResult.approved);
    const confidenceScore = Number(parsedResult.confidenceScore) || 0.0;
    const marketRegime = String(parsedResult.marketRegime || "UNKNOWN_OR_ERROR");
    const reasoning = String(parsedResult.reasoning || "Evaluation complete.");

    // Local Confidence Enforcement Gate
    // Require confidenceScore >= 0.80 and approved === true to allow execution
    if (approved && confidenceScore < 0.80) {
      return NextResponse.json({
        approved: false,
        confidenceScore,
        marketRegime,
        reasoning: `AI Supervisor veto: Confidence score (${(confidenceScore * 100).toFixed(1)}%) below required 80.0% threshold. ${reasoning}`,
      });
    }

    return NextResponse.json({
      approved,
      confidenceScore,
      marketRegime,
      reasoning,
    });
  } catch (error: any) {
    return NextResponse.json({
      approved: false,
      confidenceScore: 0.0,
      marketRegime: "UNKNOWN_OR_ERROR",
      reasoning: `AI Supervisor offline/timeout - safety veto triggered (${error?.message || "Internal error"}).`,
    });
  }
}
