// Orchestrator: turns a validated request into the final response object,
// implementing the adaptive thinking matrix (SPEC.md "Adaptive routing").
//
// Compute is routed by RISK: clear high-confidence tickets return instantly
// from rules (no LLM); ambiguous, low-context, or high-stakes tickets escalate
// to Gemini at thinkingLevel=high. Low-context cases are additionally forced to
// human review with a capped confidence, because reasoning cannot invent
// missing facts.

const { classify } = require("./classify");
const { callGemini } = require("./gemini");
const { sanitizeSummary } = require("./safety");
const { CASE_TYPES, SEVERITIES, DEPARTMENTS, DEPT_BY_CASE, SEVERITY_BY_CASE } = require("./enums");

const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

const HIGH_CONF = 0.8;
const MED_CONF = 0.55;
const LOW_CONTEXT = 0.4;

// Neutral, safety-clean summaries for the rules-only path (clear cases only).
function templateSummary(caseType) {
  switch (caseType) {
    case "wrong_transfer":
      return "Customer reports sending money to the wrong recipient and requests recovery.";
    case "payment_failed":
      return "Customer reports a failed payment with a possible balance deduction.";
    case "refund_request":
      return "Customer is requesting a refund for a recent transaction.";
    case "phishing_or_social_engineering":
      return "Customer reports a suspected phishing or social-engineering attempt; flagged for fraud review.";
    default:
      return "Customer reports an issue that does not fit the defined categories.";
  }
}

// Decide the route from the rules signal.
// Deterministic risk handling (forceHumanReview + confidence cap) applies in
// BOTH modes; a pure-rules deployment must still flag thin/uncertain tickets,
// since it has no LLM escalation as a safety net. The LLM decision is layered
// on top and only fires when the model is enabled.
function decideRoute({ case_type, severity, confidence, context }, llmEnabled) {
  const phishingOrCritical = case_type === "phishing_or_social_engineering" || severity === "critical";
  const lowContext = context < LOW_CONTEXT;
  const lowConf = confidence < MED_CONF;
  const medConf = confidence >= MED_CONF && confidence < HIGH_CONF;

  const forceHumanReview = lowContext;
  const confCap = lowContext ? 0.5 : lowConf ? 0.7 : 1;

  let useLLM = false;
  let thinkingLevel = "medium";
  if (llmEnabled) {
    if (lowContext || phishingOrCritical || lowConf) {
      useLLM = true;
      thinkingLevel = "high";
    } else if (medConf) {
      useLLM = true;
      thinkingLevel = "low";
    }
  }

  return { useLLM, thinkingLevel, forceHumanReview, confCap };
}

function higherStakes(a, b) {
  return SEV_RANK[SEVERITY_BY_CASE[a]] >= SEV_RANK[SEVERITY_BY_CASE[b]] ? a : b;
}

async function handleTicket(req, opts = {}) {
  const llmEnabled =
    opts.llmEnabled !== undefined
      ? opts.llmEnabled
      : process.env.USE_LLM !== "false" && !!process.env.GEMINI_API_KEY;

  const ticket_id = req.ticket_id;
  const message = req.message;
  const channel = req.channel;
  const locale = req.locale;

  const rules = classify(message, locale);
  const route = decideRoute(rules, llmEnabled);

  let case_type = rules.case_type;
  let severity = rules.severity;
  let department = rules.department;
  let confidence = rules.confidence;
  let agent_summary = templateSummary(case_type);
  let forceHumanReview = route.forceHumanReview;
  let disagreement = false;
  let usedLLM = false;
  let usedModel = "none";
  let thinkingLevel = route.useLLM ? route.thinkingLevel : "none";

  if (route.useLLM) {
    try {
      const llm = await callGemini({
        message,
        channel,
        locale,
        thinkingLevel: route.thinkingLevel,
        timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 25000),
      });
      usedLLM = true;
      usedModel = llm._model || "unknown";

      const llmCase = CASE_TYPES.includes(llm.case_type) ? llm.case_type : rules.case_type;
      disagreement = llmCase !== rules.case_type;

      case_type = disagreement ? higherStakes(llmCase, rules.case_type) : llmCase;

      const llmSev = SEVERITIES.includes(llm.severity) ? llm.severity : SEVERITY_BY_CASE[case_type];
      severity =
        SEV_RANK[llmSev] >= SEV_RANK[SEVERITY_BY_CASE[case_type]]
          ? llmSev
          : SEVERITY_BY_CASE[case_type];

      department = DEPARTMENTS.includes(llm.department) ? llm.department : DEPT_BY_CASE[case_type];
      if (disagreement) department = DEPT_BY_CASE[case_type];

      agent_summary =
        typeof llm.agent_summary === "string" && llm.agent_summary.trim()
          ? llm.agent_summary.trim()
          : templateSummary(case_type);

      confidence = typeof llm.confidence === "number" ? llm.confidence : rules.confidence;
      if (disagreement) confidence = Math.min(confidence, 0.6);
    } catch (err) {
      // Escalation failed/timed out: keep the deterministic label and force a
      // human to review it (we wanted a careful look but could not get one).
      forceHumanReview = true;
      thinkingLevel = "fallback_rules";
      console.error("[sort-ticket " + ticket_id + "] LLM escalation failed: " + err.message);
    }
  }

  // Mandatory safety post-filter on whatever summary we ended up with.
  const safe = sanitizeSummary(agent_summary, case_type);
  agent_summary = safe.summary;

  confidence = Math.max(0.05, Math.min(route.confCap, Number(Number(confidence).toFixed(2))));

  const human_review_required =
    severity === "critical" ||
    case_type === "phishing_or_social_engineering" ||
    forceHumanReview ||
    disagreement ||
    safe.sanitized;

  const response = {
    ticket_id,
    case_type,
    severity,
    department,
    agent_summary,
    human_review_required,
    confidence,
  };

  // Audit trail (stderr only; never part of the graded response body).
  console.error(
    "[route " + ticket_id + "] llm=" + usedLLM + " model=" + usedModel + " think=" + thinkingLevel +
      " ruleConf=" + rules.confidence + " ctx=" + rules.context +
      " disagree=" + disagreement + " final=" + case_type + "/" + severity +
      " hrr=" + human_review_required
  );

  return response;
}

module.exports = { handleTicket, decideRoute, templateSummary };
