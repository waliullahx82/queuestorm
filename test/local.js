// Local test harness (Koushik's review tool — no server, no network needed).
//
//   node test/local.js            -> classify test/ticket.json, write response.json
//   node test/local.js --cases    -> run the 5 public sample cases + edge cases
//
// By default this runs RULES-ONLY (llmEnabled:false) so it is deterministic and
// offline. To exercise the Gemini path, set GEMINI_API_KEY and USE_LLM=true and
// remove the explicit { llmEnabled:false } below.

const fs = require("fs");
const path = require("path");
const { handleTicket } = require("../lib/handle");

const PUBLIC_CASES = [
  { in: { ticket_id: "S-1", message: "I sent 3000 to wrong number" }, expect: { case_type: "wrong_transfer", severity: "high" } },
  { in: { ticket_id: "S-2", message: "Payment failed but balance deducted" }, expect: { case_type: "payment_failed", severity: "high" } },
  { in: { ticket_id: "S-3", message: "Someone called asking my OTP, is that bKash?" }, expect: { case_type: "phishing_or_social_engineering", severity: "critical" } },
  { in: { ticket_id: "S-4", message: "Please refund my last transaction, I changed my mind" }, expect: { case_type: "refund_request", severity: "low" } },
  { in: { ticket_id: "S-5", message: "App crashed when I opened it" }, expect: { case_type: "other", severity: "low" } },
];

const EDGE_CASES = [
  { in: { ticket_id: "E-1", message: "help" }, note: "very low context -> human review, capped confidence" },
  { in: { ticket_id: "E-2", locale: "mixed", message: "taka gelo keu OTP chailo ki korbo" }, note: "mixed locale phishing -> critical + review" },
  { in: { ticket_id: "E-3", message: "refund chai, vul number e taka pathaisi" }, note: "conflict refund vs wrong_transfer -> lower confidence" },
];

async function runCases() {
  let pass = 0;
  console.log("=== PUBLIC SAMPLE CASES (rules-only) ===");
  for (const c of PUBLIC_CASES) {
    const r = await handleTicket(c.in, { llmEnabled: false });
    const ok = r.case_type === c.expect.case_type && r.severity === c.expect.severity;
    pass += ok ? 1 : 0;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${c.in.ticket_id}  got=${r.case_type}/${r.severity} ` +
        `exp=${c.expect.case_type}/${c.expect.severity}  hrr=${r.human_review_required} conf=${r.confidence}`
    );
  }
  console.log(`\n${pass}/${PUBLIC_CASES.length} public cases passed.\n`);

  console.log("=== EDGE CASES (rules-only) ===");
  for (const c of EDGE_CASES) {
    const r = await handleTicket(c.in, { llmEnabled: false });
    console.log(`${c.in.ticket_id}  ${c.note}`);
    console.log(`     -> ${JSON.stringify(r)}`);
  }
  process.exit(pass === PUBLIC_CASES.length ? 0 : 1);
}

async function runSingle() {
  const file = path.join(__dirname, "ticket.json");
  const req = JSON.parse(fs.readFileSync(file, "utf8"));
  const useLLM = process.env.USE_LLM === "true" && !!process.env.GEMINI_API_KEY;
  const r = await handleTicket(req, { llmEnabled: useLLM });
  const out = path.join(__dirname, "response.json");
  fs.writeFileSync(out, JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
  console.log(`\nWrote ${out}`);
}

(async () => {
  if (process.argv.includes("--cases")) await runCases();
  else await runSingle();
})();
