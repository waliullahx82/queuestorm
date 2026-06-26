# QueueStorm — Ticket Sorter

An AI/API service that triages a single CRM / mobile-money support ticket (bKash-style) into a structured, safety-checked classification. Built for the **bKash presents SUST CSE Carnival 2026: Codex Community Hackathon** (AI/API Challenge, 4-hour online preliminary).

It is a **backend-only** service. Send one customer message to `POST /sort-ticket` and it returns a strict JSON object — case type, severity, owning department, a short agent summary, a human-review flag, and a calibrated confidence score. A liveness probe lives at `GET /health`.

The design philosophy matches the contest's evaluation principle: correct, evidence-grounded reasoning and safe behaviour over flash. A deterministic rules engine handles clear tickets instantly and cheaply; ambiguous, low-context, or high-stakes tickets escalate to a Gemini model at higher reasoning effort. Every response — regardless of source — passes a deterministic safety filter before it leaves the service.

---

## How it works

```
                 ┌──────────────┐
   request  ───► │  validate    │  missing ticket_id/message → HTTP 400
                 │ (sort-ticket)│
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   emits: case_type, severity, department,
                 │ rules engine │   confidence (0–1), context (0–1)
                 │ classify.js  │
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐   risk-based routing decides whether to
                 │  orchestrator│   call the LLM and at what thinking level
                 │  handle.js   │
                 └──────┬───────┘
              clear  ◄──┴──►  ambiguous / low-context / high-stakes
            (rules only)        (escalate to Gemini, gemini.js)
                        ▼
                 ┌──────────────┐   strips any request for PIN/OTP/password/
                 │ safety filter│   card from the summary (always runs)
                 │  safety.js   │
                 └──────┬───────┘
                        ▼
                  strict JSON response (HTTP 200)
```

**Adaptive routing — compute scales with risk.** The rules engine reports both how cleanly one label won (`confidence`) and how much real signal the message carries (`context`). The orchestrator uses those to route:

| Rules signal | LLM call? | Thinking level | Human review | Confidence cap |
|---|---|---|---|---|
| confidence ≥ 0.80, not phishing/critical | No (deterministic) | — | per rule | — |
| phishing or critical (any confidence) | Yes (verify) | high | forced true | — |
| confidence 0.55–0.79, context ≥ 0.40 | Yes | low | if disagreement | — |
| confidence < 0.55, context ≥ 0.40 | Yes | high | if disagreement | 0.70 |
| context < 0.40 (any confidence) | Yes | high | forced true | 0.50 |

Clear tickets are instant and free. High-stakes and uncertain tickets get maximum reasoning, because a wrong label there is the most damaging. **Low-context messages are the deliberate exception:** more reasoning cannot invent missing facts, so they are forced to human review with a capped confidence instead of a confident guess.

---

## API contract

### `GET /health`
Liveness probe. No LLM call, no dependencies, responds in well under the limit.

```json
{ "status": "ok", "service": "queuestorm-ticket-sorter", "time": "2026-06-26T12:00:00.000Z" }
```

### `POST /sort-ticket`
Classify one ticket.

**Request**

```json
{ "ticket_id": "T-001", "channel": "app", "locale": "en", "message": "I sent 3000 to the wrong number" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `ticket_id` | string | yes | Echoed back verbatim. Missing/empty → HTTP 400. |
| `message` | string | yes | Free-text complaint. Missing/empty → HTTP 400. |
| `channel` | string | no | `app \| sms \| call_center \| merchant_portal`. Unknown values tolerated. |
| `locale` | string | no | `bn \| en \| mixed`. Unknown values tolerated. |

**Response**

```json
{
  "ticket_id": "T-001",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports sending money to the wrong recipient and requests recovery.",
  "human_review_required": true,
  "confidence": 0.85
}
```

**Enums (enforced everywhere — rules, LLM schema, and validator):**

- `case_type` — `wrong_transfer`, `payment_failed`, `refund_request`, `phishing_or_social_engineering`, `other`
- `severity` — `low`, `medium`, `high`, `critical`
- `department` — `customer_support`, `dispute_resolution`, `payments_ops`, `fraud_risk`
- `confidence` — float in `[0, 1]`

**Deterministic mappings** (never left to the model alone):

| case_type | department | baseline severity |
|---|---|---|
| wrong_transfer | dispute_resolution | high |
| payment_failed | payments_ops | high |
| refund_request | customer_support (dispute_resolution if contested) | low |
| phishing_or_social_engineering | fraud_risk | critical |
| other | customer_support | low |

`human_review_required` is **computed deterministically** (the model never sets it). It is `true` when any of these hold: severity is `critical`; case is `phishing_or_social_engineering`; the message was low-context; the rules and LLM disagreed; the LLM escalation failed/timed out; or the safety filter had to rewrite the summary.

**Status codes:** `200` on every successful classification, `400` for missing/invalid `ticket_id`/`message` or an unparseable JSON body, `405` for non-POST methods. The service **never returns 5xx to the grader** — see Reliability below.

---

## AI usage

The LLM is used only on the slice of tickets that need it (ambiguous, low-context, or high-stakes). Everything else is answered deterministically by the rules engine.

- **Model chain with failover:** `gemini-3.5-flash` (primary) → `gemini-2.5-flash` (fallback). On retryable errors (`429`, `500`, `503`, `504`) the call retries with short backoff, then fails over to the next model — all inside the request timeout budget.
- **Reasoning effort scales with risk.** The abstract thinking level (`minimal` / `low` / `medium` / `high`) is mapped per model: Gemini 3.x uses `thinkingConfig.thinkingLevel`; Gemini 2.5.x uses an integer `thinkingConfig.thinkingBudget` (`-1` = dynamic for high, `0` for low/minimal).
- **Structured output.** The call sets `responseMimeType: "application/json"` plus a `responseSchema` that constrains the model to valid enums and a confidence float. The model returns only `case_type`, `severity`, `department`, `agent_summary`, `confidence` — never `ticket_id` or `human_review_required`, which stay deterministic.
- **Conservative merge.** When the LLM and rules disagree, the orchestrator keeps the higher-stakes label, resets the department to the deterministic mapping, and lowers confidence. Severity is never reduced below the case-type baseline.
- **Authentication** is via the `x-goog-api-key` header; the key is read from the environment and never hardcoded or logged.

The system prompt (`lib/gemini.js > SYSTEM_RULES`) pins the enum definitions, requires English summaries by default (Bangla only when the message is clearly Bangla), states the hard safety rule, and instructs the model to return low confidence when a message is vague.

---

## Safety logic

Safety is treated as a hard requirement, not a feature.

- **A deterministic post-filter (`lib/safety.js`) runs on every response**, whether the summary came from the rules engine or the LLM. It blocks any summary that asks the customer to share/send/enter/confirm a **PIN, OTP, password, or full card number** and replaces it with a neutral, classification-preserving summary. Merely *describing* that a scammer asked for an OTP is allowed; *instructing* the customer to provide one is not.
- When the filter rewrites a summary, `human_review_required` is forced `true`.
- **Phishing always wins ties** in the rules engine, because a missed phishing ticket is the most reputationally costly error.
- The service recommends a review but never claims to perform account actions, and guides customers only to official support channels.

This maps directly onto the contest's safety penalties — requesting credentials, performing unauthorised actions, or directing customers to suspicious third parties — all of which the design is built to avoid.

---

## Performance & reliability

- **Never 5xx to the grader.** A top-level guard in `api/sort-ticket.js` catches any unexpected error and returns a safe, reviewable `other` / `low` / `confidence 0.2` / `human_review_required: true` label at HTTP 200.
- **Hard timeout budget.** LLM escalation is bounded by `LLM_TIMEOUT_MS` (default 25 s). On timeout or error the deterministic rules label is returned with `human_review_required: true`, staying inside the 30 s per-request limit.
- **`/health` is dependency-free** so readiness never blocks on the LLM.
- **Unexpected input** (bad JSON, missing fields, unknown enums) yields a controlled `400` or a safe fallback — never a crash.
- **No secrets in code, logs, or responses.** The audit trail is written to stderr only and is never part of the graded response body.

---

## Setup & local development

**Requirements:** Node.js 18+ (uses the built-in global `fetch`; no runtime npm dependencies).

```bash
cd server

# 1. Configure environment (optional — the service runs rules-only without a key)
cp .env.example .env.local
#   then edit .env.local and set GEMINI_API_KEY=... to enable Gemini escalation

# 2. Run the local server (reuses the real api/ + lib/ pipeline)
node server.local.js                         # rules-only, no LLM
node --env-file=.env.local server.local.js   # with Gemini escalation enabled
```

The server listens on `http://localhost:3001` and serves `GET /health` and `POST /sort-ticket`.

**Quick check:**

```bash
curl http://localhost:3001/health

curl -X POST http://localhost:3001/sort-ticket \
  -H "Content-Type: application/json" \
  -d '{"ticket_id":"T-001","channel":"app","locale":"en","message":"I sent 3000 to wrong number"}'
```

### Configuration

All variables are read from the environment (set them in `.env.local` for dev, or the host's dashboard in production). Only `GEMINI_API_KEY` matters; everything else has a safe default.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | _(unset)_ | Google AI Studio key. If unset, the service runs **rules-only**. |
| `USE_LLM` | `true` | Set to `false` to force a pure rules service even with a key present. |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Primary model (tried first). |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash` | Used when the primary returns 503/429. |
| `LLM_RETRIES` | `1` | Attempts per model before failover. |
| `LLM_TIMEOUT_MS` | `25000` | Hard escalation budget; on timeout → rules label + review. |
| `GEMINI_BASE` | Google API base URL | Override for testing/proxying. |

Secrets are never committed: `.env.example` holds variable names only; real keys go in `.env.local` (git-ignored) for dev or the host's environment settings in production. Rotate or delete the key after the round.

---

## Testing

```bash
cd server

node test/local.js --cases                 # 5 public sample cases + edge cases (rules-only, offline)
node test/local.js                          # classify test/ticket.json → writes response.json
node --env-file=.env.local test/ten.js      # 10-sample live integration test (exercises the Gemini path)
bash test/smoke.sh https://<your-deploy>    # health + 5 samples against a deployed instance
```

`test/local.js --cases` is deterministic and needs no network or key — it asserts the expected `case_type`/`severity` for every public sample and prints the edge-case behaviour (low context, mixed-locale phishing, conflicting signals). `test/ten.js` validates response shape, safety, and `ticket_id` echo across 10 realistic English/Bangla/mixed tickets and prints per-request latency.

---

## Deployment

The handlers in `api/` (`health.js`, `sort-ticket.js`) are written as standard Vercel serverless functions — each exports `(req, res)` and reads `req.body` / writes `res.status().json()`. To deploy on Vercel: import the repo (framework preset **Other**, no build command), add a route mapping so the functions answer at `/health` and `/sort-ticket` (a `vercel.json` rewrite), set `GEMINI_API_KEY` in the project's environment variables, and the public HTTPS endpoint is ready for the judge harness. Give `sort-ticket` enough function duration (e.g. `maxDuration: 60`) so a high-thinking escalation is never killed before the internal 25 s abort.

For a self-hosted or Docker fallback, `server.local.js` is a zero-dependency HTTP server that runs the identical pipeline — point it at a port, set the same environment variables, and it serves the same two routes.

> **Note for graders:** this snapshot has no runtime npm dependencies, so the service runs directly with `node`. A `vercel.json` / `Dockerfile` for your target platform is the final deployment step; the application code itself is complete and tested.

---

## Project structure

```
server/
├── api/
│   ├── health.js          GET  /health  — liveness, no LLM
│   └── sort-ticket.js      POST /sort-ticket — validate, delegate, never 500
├── lib/
│   ├── enums.js            single source of truth for enums + deterministic mappings
│   ├── classify.js         dependency-free rules engine (confidence + context scoring)
│   ├── handle.js           orchestrator — adaptive risk routing + deterministic flags
│   ├── gemini.js           Gemini escalation: model chain, structured output, retries
│   └── safety.js           mandatory credential-solicitation post-filter
├── test/
│   ├── local.js            offline rules tests (public cases + edge cases)
│   ├── ten.js              live 10-sample integration test
│   ├── smoke.sh            curl smoke test against a deployed URL
│   └── ticket.json         single-ticket fixture
├── server.local.js         zero-dependency local/dev/Docker server
└── .env.example            environment template
SPEC.md                     authoritative classification & payload contract
```

`SPEC.md` is the authoritative contract; `lib/` is its reference implementation.

---

## Known limitations

- **Rules-only fallback is shallower.** Without `GEMINI_API_KEY` the service still classifies, validates, and enforces safety, but relies on keyword matching plus the context gate. It compensates by forcing human review on thin/uncertain tickets rather than guessing.
- **Keyword coverage is finite.** The rules engine covers common English plus a handful of romanized Bangla tokens (`bhul`, `ferot`, `taka kete`, …). Unusual phrasings lean on LLM escalation; with the LLM disabled they may land in `other`.
- **The response intentionally omits internals.** Whether the LLM actually ran (full-AI vs degraded/rules-only) and *why* `human_review_required` is true are written to stderr only, to keep the graded response schema strict. A consumer UI cannot truthfully distinguish modes without an added optional `_meta` field.
- **Model/API drift.** Gemini reasoning-config keys (`thinkingLevel` vs `thinkingBudget`) and `responseSchema` support should be re-verified against current Google AI docs before a live run. The primary `gemini-3.5-flash` was observed returning `503` under load, in which case escalations succeed automatically on the `gemini-2.5-flash` fallback (or force it as primary via `GEMINI_MODEL=gemini-2.5-flash`).
- **Single-ticket scope.** Each request classifies exactly one ticket; there is no batch endpoint or persistence layer.

---

## Team

Kawsar (backend / deployment) · Koushik (AI prompt / payload schema) · Tonmoy (repository).
