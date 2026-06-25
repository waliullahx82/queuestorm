# QueueStorm Ticket Sorter

Web service for the SUST CSE Carnival 2026 **mock preliminary** (QueueStorm Warmup).
It reads one CRM ticket and returns a structured classification: `case_type`,
`severity`, `department`, a two-second `agent_summary`, a `human_review_required`
flag, and a `confidence` score.

**Owner of this handoff:** Kawsar (backend + deploy). Classification/prompt contract
authored by Koushik (see `SPEC.md`). The pipeline is already built, tested, and
working locally. Your job is to put it on a public HTTPS URL and submit it.

---

## TL;DR for Kawsar (your next steps, in order)

1. `node test/local.js --cases` -> confirms 5/5 public cases pass offline (no key needed).
2. Push this folder to a **public** GitHub repo (Tonmoy creates the repo; you deploy).
3. Deploy on **Vercel** (steps below). Framework preset = **Other**, no build command.
4. Add the secret `GEMINI_API_KEY` in Vercel env settings (value comes from Koushik).
5. `bash test/smoke.sh https://<your-project>.vercel.app` -> confirms the live URL.
6. Submit the Google Form: base URL = `https://<your-project>.vercel.app`,
   LLM used = **Yes, Gemini (3.5-flash primary, 2.5-flash fallback)**.

If anything about the LLM is flaky on the day, set `USE_LLM=false` in Vercel and
redeploy -- the service still passes all public cases as a pure rules engine.

---

## Endpoints

- `GET /health` -> `{ "status": "ok", ... }` (fast, no LLM).
- `POST /sort-ticket` -> classification JSON. Request/response schema in `SPEC.md`.

Example:

```bash
curl -X POST https://<your-project>.vercel.app/sort-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticket_id":"T-001","channel":"app","locale":"en","message":"I sent 5000 taka to a wrong number"}'
```

## How it works (one paragraph)

A deterministic rules classifier (`lib/classify.js`) labels every ticket and scores
its own `confidence` and the message's `context` richness. Clear, high-confidence
tickets return instantly with no LLM call. Ambiguous, low-context, or high-stakes
(phishing/critical) tickets escalate to Gemini with reasoning effort scaled UP by
risk (`thinkingLevel: high`). The model only fills the label fields; `ticket_id`,
`human_review_required`, and the safety check stay deterministic. Every escalation
has a hard timeout and a model fallback, so the service degrades to the rules label
(with human review forced) instead of failing. Full design: `SPEC.md`.

## Project layout

```
api/health.js          GET /health        (Vercel serverless fn)
api/sort-ticket.js     POST /sort-ticket  (validation -> lib/handle)
lib/enums.js           canonical enums + case->dept/severity maps
lib/classify.js        deterministic rules classifier (confidence + context)
lib/gemini.js          Gemini call: responseSchema + thinkingLevel + retry + model fallback
lib/safety.js          PIN/OTP/password post-filter (auto-fail guard)
lib/handle.js          adaptive routing matrix + response assembly
test/local.js          offline harness: --cases, or ticket.json -> response.json
test/ten.js            10-sample live test (needs key): node --env-file=.env.local test/ten.js
test/smoke.sh          curl smoke test against a deployed URL
vercel.json            /health + /sort-ticket rewrites, function maxDuration
.env.example           variable NAMES only (no secrets)
```

## Run locally

```bash
npm run test:cases                       # 5 public cases + edge cases, rules-only, offline
npm run test:local                       # classify test/ticket.json -> test/response.json
node --env-file=.env.local test/ten.js   # 10-sample LIVE test (exercises Gemini)
```

## Deploy on Vercel

1. Vercel -> **New Project** -> import the GitHub repo. Framework preset: **Other**.
   No build command; the `api/` functions deploy automatically.
2. Set the secret (see below), then **Deploy**.
3. Verify: `GET /health` returns ok; `POST /sort-ticket` returns a classification.
4. `vercel.json` rewrites `/health` and `/sort-ticket` to the functions and sets
   `maxDuration: 60` on `sort-ticket` so a high-thinking escalation is never killed
   before the internal 25s abort.

## SECRET HANDLING (manual; never paste keys into chat, Discord, or the repo)

1. Koushik creates the key at https://aistudio.google.com/apikey (personal AI Studio).
2. Vercel -> Project -> Settings -> Environment Variables -> add
   `GEMINI_API_KEY` = <value>, for Production + Preview. Redeploy.
3. Local dev: copy `.env.example` to `.env.local`, put the key there (git-ignored).
4. Rotate/delete the key after the round.

## Heads-up / known state (as of last test)

- The LLM path is verified working, but `gemini-3.5-flash` was returning HTTP 503
  ("high demand") in testing, so escalations succeeded on the `gemini-2.5-flash`
  **fallback**. This is automatic. If 3.5 stays down on contest day, you can also
  force the fallback as primary: set `GEMINI_MODEL=gemini-2.5-flash` in Vercel.
- Verify exact `thinkingConfig` / `responseSchema` field names against current
  Google AI docs before the real event (noted in `SPEC.md` section 6).
- Romanized-Bangla keyword coverage in the rules engine is best-effort; the LLM
  escalation handles unusual `mixed` / `bn` phrasing.
