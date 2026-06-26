// Deterministic safety guard for agent_summary.
//
// Spec section 5: agent_summary must NEVER ask the customer to share PIN, OTP,
// password, or full card number. The grader auto-fails any response that does.
// Structured output does NOT guarantee this, so we enforce it ourselves AFTER
// generation, regardless of whether the summary came from rules or the LLM.

// Patterns that constitute a "request to share" a credential.
// We intentionally target the *ask/share* framing, not mere mention, so a
// summary that says "scammer asked for the customer's OTP" stays allowed,
// while "please share your OTP" is blocked.
const SOLICIT_RE = new RegExp(
  [
    // verb (share/send/provide/give/tell/enter/confirm/verify) ... credential
    "(share|send|provide|give|tell|enter|type|confirm|verify|resend|forward)\\b" +
      "[^.?!]{0,40}\\b(otp|pin|password|card\\s*number|cvv|one[-\\s]?time\\s*(password|code)|verification\\s*code)",
    // credential ... please / now (imperative ask)
    "\\b(otp|pin|password|cvv)\\b[^.?!]{0,20}\\b(please|now|immediately|to (us|me))",
  ].join("|"),
  "i"
);

function violatesSafety(summary) {
  return SOLICIT_RE.test(String(summary || ""));
}

// If a summary violates the rule, replace it with a neutral, safe summary that
// preserves the classification meaning without any credential solicitation.
function sanitizeSummary(summary, caseType) {
  if (!violatesSafety(summary)) return { summary, sanitized: false };

  const fallbackByCase = {
    phishing_or_social_engineering:
      "Customer reports a suspected phishing or social-engineering attempt; flagged for fraud review.",
    wrong_transfer:
      "Customer reports a transfer to the wrong recipient and requests recovery.",
    payment_failed:
      "Customer reports a failed payment with a possible balance deduction.",
    refund_request: "Customer is requesting a refund for a recent transaction.",
    other: "Customer reports an issue requiring agent review.",
  };

  return {
    summary: fallbackByCase[caseType] || fallbackByCase.other,
    sanitized: true,
  };
}

module.exports = { violatesSafety, sanitizeSummary, SOLICIT_RE };
