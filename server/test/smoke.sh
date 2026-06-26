#!/usr/bin/env bash
# Smoke test for a deployed instance. Usage:
#   bash test/smoke.sh https://your-project.vercel.app
# Checks /health and posts the 5 public sample tickets to /sort-ticket.
set -euo pipefail
BASE="${1:?Usage: bash test/smoke.sh <base-url>}"

echo "== GET $BASE/health =="
curl -fsS "$BASE/health"; echo

post() {
  echo "== POST /sort-ticket : $1 =="
  curl -fsS -X POST "$BASE/sort-ticket" \
    -H "Content-Type: application/json" \
    -d "$2"; echo
}

post "wrong_transfer"  '{"ticket_id":"S-1","channel":"app","locale":"en","message":"I sent 3000 to wrong number"}'
post "payment_failed"  '{"ticket_id":"S-2","channel":"app","locale":"en","message":"Payment failed but balance deducted"}'
post "phishing"        '{"ticket_id":"S-3","channel":"call_center","locale":"en","message":"Someone called asking my OTP, is that bKash?"}'
post "refund_request"  '{"ticket_id":"S-4","channel":"app","locale":"en","message":"Please refund my last transaction, I changed my mind"}'
post "other"           '{"ticket_id":"S-5","channel":"app","locale":"en","message":"App crashed when I opened it"}'

echo "== done =="
