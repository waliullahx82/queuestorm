// Deterministic, dependency-free rules classifier.
// Returns a provisional label PLUS confidence and context scores that the
// orchestrator (lib/handle.js) uses to decide whether to escalate to the LLM
// and at which thinking level.
//
// Design notes:
// - Keyword tables include common English plus a few romanized Bangla tokens
//   seen in `mixed` locale tickets ("bhul", "ferot", "taka kete").
// - confidence reflects how cleanly ONE case_type won. Conflicts lower it.
// - context reflects signal richness (length + presence of amount/action words).
//   Low context never produces a high confidence, no matter the keyword hit.

const { DEPT_BY_CASE, SEVERITY_BY_CASE } = require("./enums");

// Each entry: case_type -> array of lowercase substrings / regex sources.
const KEYWORDS = {
  phishing_or_social_engineering: [
    "otp", "pin", "password", "card number", "cvv", "verification code",
    "asking my", "asking for my", "share your", "share my", "scam", "scammer",
    "fraud", "suspicious call", "suspicious sms", "pretending", "is that bkash",
    "is this bkash", "gave my", "asked for my", "gopon", // bn: secret
  ],
  wrong_transfer: [
    "wrong number", "wrong recipient", "wrong account", "wrong person",
    "sent to wrong", "sent to the wrong", "mistakenly sent", "sent by mistake",
    "wrong nagad", "wrong bkash number", "bhul", "vul", // bn: wrong
  ],
  payment_failed: [
    "payment failed", "transaction failed", "failed but", "didn't go through",
    "did not go through", "balance deducted", "balance cut", "money deducted",
    "money cut", "deducted but", "taka kete", "kete nilo", "cash out failed",
    "send money failed", "stuck", "pending but deducted",
  ],
  refund_request: [
    "refund", "money back", "return my money", "give it back", "want my money",
    "changed my mind", "cancel", "ferot", "ferot chai", // bn: return
  ],
};

// Words/patterns that indicate the message carries real signal (context).
const AMOUNT_RE = /(\d[\d,]*\s*(tk|taka|bdt|৳)?)|৳\s*\d/i;
const ACTION_RE = /(sent|send|transfer|paid|pay|refund|deduct|fail|call|sms|asked|received)/i;

function normalize(message) {
  return String(message || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Count keyword hits per case_type.
function scoreHits(text) {
  const hits = {};
  for (const [caseType, words] of Object.entries(KEYWORDS)) {
    let count = 0;
    const matched = [];
    for (const w of words) {
      if (text.includes(w)) {
        count += 1;
        matched.push(w);
      }
    }
    hits[caseType] = { count, matched };
  }
  return hits;
}

// context score in [0,1]: longer, amount-bearing, action-bearing => higher.
function scoreContext(text) {
  if (!text) return 0;
  let score = 0;
  const len = text.length;
  if (len >= 25) score += 0.4;
  else if (len >= 12) score += 0.2;
  if (AMOUNT_RE.test(text)) score += 0.3;
  if (ACTION_RE.test(text)) score += 0.3;
  return Math.min(1, score);
}

/**
 * classify(message, locale) -> {
 *   case_type, severity, department,
 *   confidence,            // 0..1, calibrated by hits + conflict + context
 *   context,               // 0..1 signal richness
 *   matched,               // keywords that fired (for logging/debug)
 *   conflict               // true if >1 case_type fired with hits
 * }
 */
function classify(message, locale) {
  const text = normalize(message);
  const context = scoreContext(text);
  const hits = scoreHits(text);

  // Rank case types by hit count.
  const ranked = Object.entries(hits)
    .map(([caseType, h]) => ({ caseType, count: h.count, matched: h.matched }))
    .sort((a, b) => b.count - a.count);

  const top = ranked[0];
  const second = ranked[1];
  const totalHits = ranked.reduce((s, r) => s + r.count, 0);

  let caseType;
  let conflict = false;
  let confidence;

  if (!top || top.count === 0) {
    // No keyword matched at all -> "other", low confidence.
    caseType = "other";
    confidence = 0.3;
  } else {
    // Safety-first tie handling: phishing always wins a tie because a missed
    // phishing ticket is the most reputationally costly error.
    const phish = hits.phishing_or_social_engineering;
    if (phish.count > 0 && phish.count >= top.count) {
      caseType = "phishing_or_social_engineering";
    } else {
      caseType = top.caseType;
    }

    conflict = !!(second && second.count > 0 && caseType !== "phishing_or_social_engineering");

    // Base confidence from dominance of the winning case_type.
    const winnerCount = hits[caseType].count;
    const dominance = winnerCount / totalHits; // 1 == clean win
    confidence = 0.55 + 0.4 * dominance; // 0.55..0.95
    if (conflict) confidence -= 0.2;      // competing signals
  }

  // Context gate: thin messages can never be high-confidence, even on a hit.
  // (A short "help" with one stray keyword should not look certain.)
  const contextCap = 0.4 + 0.55 * context; // context 0 -> cap 0.4 ; context 1 -> 0.95
  confidence = Math.min(confidence, contextCap);
  confidence = Math.max(0.05, Math.min(0.97, Number(confidence.toFixed(2))));

  const severity = SEVERITY_BY_CASE[caseType];
  const department = DEPT_BY_CASE[caseType];

  return {
    case_type: caseType,
    severity,
    department,
    confidence,
    context: Number(context.toFixed(2)),
    matched: hits[caseType] ? hits[caseType].matched : [],
    conflict,
  };
}

module.exports = { classify, normalize, scoreContext };
