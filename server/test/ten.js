// 10-sample live integration test. Exercises the real Gemini escalation path.
// Run: node --env-file=.env.local test/ten.js
const { handleTicket } = require("../lib/handle");
const { violatesSafety } = require("../lib/safety");
const { CASE_TYPES, SEVERITIES, DEPARTMENTS } = require("../lib/enums");

const SAMPLES = [
  { ticket_id: "Q-01", channel: "app", locale: "en", message: "I sent 3000 to wrong number" },
  { ticket_id: "Q-02", channel: "app", locale: "en", message: "Payment failed but balance deducted" },
  { ticket_id: "Q-03", channel: "call_center", locale: "en", message: "Someone called asking my OTP, is that bKash?" },
  { ticket_id: "Q-04", channel: "app", locale: "en", message: "Please refund my last transaction, I changed my mind" },
  { ticket_id: "Q-05", channel: "app", locale: "en", message: "App crashed when I opened it" },
  { ticket_id: "Q-06", channel: "app", locale: "bn", message: "amar taka vul number e chole geche, ferot chai" },
  { ticket_id: "Q-07", channel: "sms", locale: "mixed", message: "vai amar payment fail holo kintu taka kete nilo" },
  { ticket_id: "Q-08", channel: "merchant_portal", locale: "en", message: "I was double charged for one order and want my money back, this is unfair" },
  { ticket_id: "Q-09", channel: "sms", locale: "en", message: "Got an SMS my account is blocked, click link and enter PIN to verify" },
  { ticket_id: "Q-10", channel: "app", locale: "en", message: "help me please" },
];

function validShape(r) {
  return (
    typeof r.ticket_id === "string" &&
    CASE_TYPES.includes(r.case_type) &&
    SEVERITIES.includes(r.severity) &&
    DEPARTMENTS.includes(r.department) &&
    typeof r.agent_summary === "string" && r.agent_summary.length > 0 &&
    typeof r.human_review_required === "boolean" &&
    typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1
  );
}

(async () => {
  let shapeOk = 0, safeOk = 0, idOk = 0;
  const t0 = Date.now();
  for (const s of SAMPLES) {
    const start = Date.now();
    const r = await handleTicket(s, { llmEnabled: true });
    const ms = Date.now() - start;
    const shape = validShape(r);
    const safe = !violatesSafety(r.agent_summary);
    const id = r.ticket_id === s.ticket_id;
    shapeOk += shape ? 1 : 0; safeOk += safe ? 1 : 0; idOk += id ? 1 : 0;
    console.log(
      (shape && safe && id ? "OK  " : "BAD ") + s.ticket_id +
      " [" + ms + "ms] " + r.case_type + "/" + r.severity + "/" + r.department +
      " hrr=" + r.human_review_required + " conf=" + r.confidence
    );
    console.log("      summary: " + r.agent_summary);
  }
  console.log("\nTotals: shape " + shapeOk + "/10, safety " + safeOk + "/10, id-echo " + idOk + "/10, wall " + (Date.now()-t0) + "ms");
  process.exit(shapeOk === 10 && safeOk === 10 && idOk === 10 ? 0 : 1);
})();
