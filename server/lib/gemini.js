// Gemini escalation call with quota-aware fallback.
//
// Only invoked by the orchestrator on the ambiguous / low-context / high-stakes
// slice (see lib/handle.js). Uses structured output (responseSchema) so the
// model can ONLY return valid enums + a confidence float. The model does NOT
// decide ticket_id or human_review_required -- those stay deterministic.
//
// Resilience: gemini-3.5-flash is the primary model but can return 503 (high
// demand) or 429 (rate limit). We retry with short backoff, then fall back to
// gemini-2.5-flash, all inside the caller's timeout budget. This is why the
// LLM path stays usable even when the newest model is capacity-constrained.
//
// API facts (verify against current docs before the real event):
//   - Gemini 3.x reasoning: generationConfig.thinkingConfig.thinkingLevel
//     ("minimal" | "low" | "medium" | "high"). Default for 3.5-flash is medium.
//   - Gemini 2.5.x reasoning: generationConfig.thinkingConfig.thinkingBudget
//     (integer; -1 = dynamic). thinkingLevel is NOT valid for 2.5, so we map.
//   - temperature/top_p/top_k omitted (Gemini 3.x guidance; harmless for 2.5).
//   - Endpoint: POST {BASE}/v1beta/models/{model}:generateContent
//   - Auth header: x-goog-api-key: $GEMINI_API_KEY (never hardcode the value).

const { CASE_TYPES, SEVERITIES, DEPARTMENTS } = require("./enums");

const BASE = process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com";

// Ordered model chain: primary first, fallback second. Override via env.
const MODEL_CHAIN = [
  process.env.GEMINI_MODEL || "gemini-3.5-flash",
  process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash",
];

const RETRYABLE = new Set([429, 500, 503, 504]);

// Structured-output schema (Gemini OpenAPI subset). The model fills only these.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    case_type: { type: "STRING", enum: CASE_TYPES },
    severity: { type: "STRING", enum: SEVERITIES },
    department: { type: "STRING", enum: DEPARTMENTS },
    agent_summary: { type: "STRING" },
    confidence: { type: "NUMBER" },
  },
  required: ["case_type", "severity", "department", "agent_summary", "confidence"],
  propertyOrdering: ["case_type", "severity", "department", "agent_summary", "confidence"],
};

const SYSTEM_RULES = [
  "You are a triage classifier for a digital-finance support desk (bKash-style).",
  "Classify ONE customer message into the fixed enums below. Be precise and conservative.",
  "",
  "case_type:",
  "- wrong_transfer: money sent to the wrong recipient/number/account.",
  "- payment_failed: a transaction failed, possibly with balance deducted.",
  "- refund_request: customer asks for a refund / money back / to cancel.",
  "- phishing_or_social_engineering: anyone asking for PIN/OTP/password/card, suspicious call/SMS, scam.",
  "- other: anything not covered above.",
  "",
  "severity: low | medium | high | critical.",
  "- phishing_or_social_engineering -> critical.",
  "- wrong_transfer and payment_failed -> high (money at risk).",
  "- refund_request -> low (medium only if clearly contested/disputed).",
  "- other -> low.",
  "",
  "department: customer_support | dispute_resolution | payments_ops | fraud_risk.",
  "- wrong_transfer -> dispute_resolution",
  "- payment_failed -> payments_ops",
  "- phishing_or_social_engineering -> fraud_risk",
  "- refund_request -> customer_support (dispute_resolution only if contested)",
  "- other -> customer_support",
  "",
  "agent_summary: ONE or TWO neutral sentences an agent can read in two seconds.",
  "- Write in English by default. Use Bangla ONLY if the customer's message is clearly in Bangla.",
  "- HARD SAFETY RULE: never ask the customer to share, send, enter, or confirm their PIN, OTP,",
  "  password, or full card number. Describe the situation only.",
  "",
  "confidence: a float 0..1. If the message is vague or lacks information, return a LOW",
  "confidence (<= 0.5) rather than guessing confidently.",
  "",
  "Return ONLY the structured JSON object.",
].join("\n");

// Map an abstract thinking level to per-model reasoning config.
function thinkingConfigFor(model, level) {
  if (/^gemini-3/.test(model)) {
    return { thinkingLevel: level }; // 3.x native
  }
  // 2.5.x uses an integer budget. high -> dynamic(-1); low/minimal -> 0; medium -> default.
  if (level === "high") return { thinkingBudget: -1 };
  if (level === "low" || level === "minimal") return { thinkingBudget: 0 };
  return undefined; // medium: leave model default
}

function buildBody(model, { message, channel, locale, thinkingLevel }) {
  const userBlock =
    "channel: " + (channel || "unknown") +
    "\nlocale: " + (locale || "unknown") +
    "\nmessage: " + message;

  const generationConfig = {
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
  };
  const tc = thinkingConfigFor(model, thinkingLevel);
  if (tc) generationConfig.thinkingConfig = tc;

  return {
    systemInstruction: { parts: [{ text: SYSTEM_RULES }] },
    contents: [{ role: "user", parts: [{ text: userBlock }] }],
    generationConfig,
  };
}

async function postOnce(model, body, apiKey, timeoutMs) {
  const url = BASE + "/v1beta/models/" + model + ":generateContent";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error("HTTP " + res.status + ": " + text.slice(0, 200));
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(text);
    const out = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    if (!out) throw new Error("empty content");
    return JSON.parse(out);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * callGemini({ message, channel, locale, thinkingLevel, timeoutMs })
 * Walks the model chain; on each model retries retryable errors with backoff,
 * all within the overall timeout budget. Returns { ...labels, _model } or throws.
 */
async function callGemini({ message, channel, locale, thinkingLevel = "medium", timeoutMs = 25000 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const deadline = Date.now() + timeoutMs;
  const maxAttemptsPerModel = Number(process.env.LLM_RETRIES || 1);
  let lastErr;

  for (const model of MODEL_CHAIN) {
    const body = buildBody(model, { message, channel, locale, thinkingLevel });
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 500) throw lastErr || new Error("LLM deadline exceeded");
      try {
        const result = await postOnce(model, body, apiKey, Math.min(remaining, 15000));
        result._model = model;
        return result;
      } catch (e) {
        lastErr = e;
        const retryable = e.status ? RETRYABLE.has(e.status) : e.name === "AbortError";
        if (!retryable) break; // non-retryable (e.g. 400) -> try next model
        if (attempt < maxAttemptsPerModel) await sleep(700 * attempt); // 0.7s, 1.4s
      }
    }
  }
  throw lastErr || new Error("all models failed");
}

module.exports = { callGemini, RESPONSE_SCHEMA, MODEL_CHAIN };
