# QueueStorm — Classification & Payload Spec

Owner: Koushik (AI prompt / payload schema). Implementer: Kawsar (server + deploy).
This is the authoritative contract. `lib/` is a reference implementation of it.

## 1. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. Returns `{ "status": "ok", ... }`, < 10s, no LLM. |
| POST | `/sort-ticket` | Classify one ticket. Returns the response schema below, < 30s. |

## 2. Request schema

```json
{ "ticket_id": "T-001", "channel": "app", "locale": "en", "message": "free text" }
```

- `ticket_id` (string, required) — echoed back verbatim.
- `channel` (optional) — `app | sms | call_center | merchant_portal`.
- `locale` (optional) — `bn | en | mixed`.
- `message` (string, required) — free-text complaint.

Validation: missing/empty `ticket_id` or `message` → HTTP 400. Unknown `channel`/`locale` are tolerated (treated as `unknown`).

## 3. Response schema

```json
{
  "ticket_id": "T-001",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports sending 5000 BDT to a wrong number and requests recovery.",
  "human_review_required": true,
  "confidence": 0.85
}
```

Enums: `case_type` ∈ {wrong_transfer, payment_failed, refund_request, phishing_or_social_engineering, other}; `severity` ∈ {low, medium, high, critical}; `department` ∈ {customer_support, dispute_resolution, payments_ops, fraud_risk}. `confidence` ∈ [0,1].

Deterministic mappings (never left to the model alone):

| case_type | department | baseline severity |
|---|---|---|
| wrong_transfer | dispute_resolution | high |
| payment_failed | payments_ops | high |
| refund_request | customer_support (dispute_resolution if contested) | low |
| phishing_or_social_engineering | fraud_risk | critical |
| other | customer_support | low |

`human_review_required` is **computed deterministically**, true if: `severity == critical` OR `case_type == phishing_or_social_engineering` OR low-context escalation OR rules/LLM disagreement OR the safety filter rewrote the summary. The model never sets this field.

## 4. Safety rule (auto-fail if broken)

`agent_summary` must never ask the customer to share/send/enter/confirm PIN, OTP, password, or full card number. Enforced by a deterministic post-filter (`lib/safety.js`) on every response regardless of source. Describing that *a scammer asked for the OTP* is allowed; instructing the customer to provide it is not.

## 5. Adaptive routing (the core design)

Compute scales **up** with risk. The rules engine emits `confidence` (how cleanly one label won) and `context` (signal richness). Routing:

| Rules signal | LLM call? | `thinkingLevel` | human_review | confidence cap |
|---|---|---|---|---|
| confidence ≥ 0.8, not phishing/critical | no (deterministic) | — | per rule | — |
| phishing or critical (any confidence) | yes (verify) | **high** | **forced true** | — |
| confidence 0.55–0.79, context ≥ 0.4 | yes | low | if disagreement | — |
| confidence < 0.55, context ≥ 0.4 | yes | **high** | if disagreement | 0.7 |
| context < 0.4 (any confidence) | yes | **high** | **forced true** | 0.5 |

Rationale: clear tickets are cheap and instant; ambiguous/high-stakes tickets get maximum reasoning because a wrong label there damages reputation. **Low context is the exception that proves the rule** — reasoning cannot recover absent facts, so those go to high thinking *and* forced human review with a capped confidence rather than a confident guess. Escalation has a hard `LLM_TIMEOUT_MS` (default 25s); on timeout/error the deterministic label is returned with `human_review_required: true`, staying inside the 30s budget.

## 6. Gemini payload (escalation path)

- Model chain: `gemini-3.5-flash` (primary) then `gemini-2.5-flash` (fallback). Endpoint: `POST {base}/v1beta/models/{model}:generateContent`. Auth header `x-goog-api-key`. On `429/500/503/504` the call retries (`LLM_RETRIES` per model) then fails over to the next model; if all fail, the deterministic rules label is returned with `human_review_required: true`.
- Per-model reasoning config differs: 3.x uses `thinkingConfig.thinkingLevel` (string); 2.5.x uses `thinkingConfig.thinkingBudget` (integer, `-1` = dynamic). The code maps the abstract level to the right field per model.
- Observed state (last test): `gemini-3.5-flash` returned `503` repeatedly; escalations succeeded on the `gemini-2.5-flash` fallback. Set `GEMINI_MODEL=gemini-2.5-flash` to skip the dead primary if needed.
- `generationConfig.responseMimeType = "application/json"` + `responseSchema` (enums enforced). Model returns only `case_type, severity, department, agent_summary, confidence` — **not** `ticket_id` or `human_review_required`.
- `generationConfig.thinkingConfig.thinkingLevel` ∈ {minimal, low, medium, high}, set per the routing table. (Replaces the old `thinkingBudget`; default for 3.5-flash is `medium`, so it is always set explicitly.)
- `temperature`/`top_p`/`top_k` omitted (Google's Gemini 3.x guidance).
- **Verify before contest:** exact `thinkingConfig` JSON key casing and `responseSchema` field support against current Google AI docs.

System-prompt intent lives in `lib/gemini.js > SYSTEM_RULES`: fixed enum definitions, English-by-default summary (Bangla only when the message is clearly Bangla), the hard safety rule, and "return low confidence when vague."

## 7. Acceptance checks

1. All 5 public sample cases return the expected `case_type` + `severity` (run `npm run test:cases`).
2. Every phishing/critical case → `human_review_required: true`.
3. No response solicits PIN/OTP/password/card in `agent_summary`.
4. `/health` < 10s, `/sort-ticket` < 30s, both over public HTTPS.
5. Response always matches the schema and enum sets; never HTTP 500 to the grader.
