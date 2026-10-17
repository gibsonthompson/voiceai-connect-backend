#!/usr/bin/env bash
# VoiceAI Connect - Agency API smoke test
#
# Exercises the /api/v1 surface end to end so a live pass is one clean run.
# Read checks always run. Write + webhook checks run only with RUN_WRITES=1,
# and they create a flagged TEST client that is deleted at the end.
#
# Usage:
#   export API_KEY=vac_live_...            # a read_write key from the dashboard
#   export BASE_URL=https://urchin-app-bqb4i.ondigitalocean.app   # optional, this is the default
#   export WEBHOOK_URL=https://webhook.site/<your-id>             # optional, enables webhook test
#   RUN_WRITES=1 ./api-smoke-test.sh       # include create/update/delete + webhook
#   ./api-smoke-test.sh                    # read-only pass
#
# Requires: curl, jq. The API key is read from the environment and never printed.

set -u
BASE_URL="${BASE_URL:-https://urchin-app-bqb4i.ondigitalocean.app}"
API="${BASE_URL%/}/api/v1"
PASS=0; FAIL=0

if [ -z "${API_KEY:-}" ]; then echo "Set API_KEY first (a read_write key)."; exit 1; fi
command -v jq >/dev/null || { echo "jq is required."; exit 1; }

hdr=(-H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json")

# check <label> <expected-status> <method> <path> [json-body]
check() {
  local label="$1" want="$2" method="$3" path="$4" body="${5:-}"
  local out code
  if [ -n "$body" ]; then
    out=$(curl -sS -w $'\n%{http_code}' -X "$method" "${hdr[@]}" -d "$body" "${API}${path}")
  else
    out=$(curl -sS -w $'\n%{http_code}' -X "$method" "${hdr[@]}" "${API}${path}")
  fi
  code=$(printf '%s' "$out" | tail -n1)
  BODY=$(printf '%s' "$out" | sed '$d')
  local good=0
  if [ "$want" = "2xx" ]; then
    case "$code" in 2??) good=1;; esac
  elif [ "$code" = "$want" ]; then good=1; fi
  if [ "$good" = "1" ]; then
    echo "  ok   [$code] $label"; PASS=$((PASS+1))
  else
    echo "  FAIL [$code, wanted $want] $label"
    echo "       $(printf '%s' "$BODY" | head -c 300)"
    FAIL=$((FAIL+1))
  fi
}

echo "== Auth + reads =="
check "GET /account" 200 GET "/account"
AGENCY=$(printf '%s' "$BODY" | jq -r '.id // .data.id // empty' 2>/dev/null)
check "GET /clients" 200 GET "/clients?limit=2"
FIRST_CLIENT=$(printf '%s' "$BODY" | jq -r '.data[0].id // empty' 2>/dev/null)
check "GET /calls" 200 GET "/calls?limit=2"
check "GET /numbers" 200 GET "/numbers"
check "GET /usage" 200 GET "/usage"
check "GET /analytics/calls" 200 GET "/analytics/calls"
check "GET /appointments" 200 GET "/appointments?limit=2"
check "GET /events" 200 GET "/events?limit=2"
check "GET /branding" 200 GET "/branding"
check "GET /webhooks" 200 GET "/webhooks"

echo "== Auth negatives =="
# Bad key -> 401
BADOUT=$(curl -sS -w $'\n%{http_code}' -H "Authorization: Bearer vac_live_definitely_invalid" "${API}/account" | tail -n1)
[ "$BADOUT" = "401" ] && { echo "  ok   [401] bad key rejected"; PASS=$((PASS+1)); } || { echo "  FAIL [$BADOUT, wanted 401] bad key"; FAIL=$((FAIL+1)); }

if [ -n "$FIRST_CLIENT" ]; then
  echo "== Per-client reads (client $FIRST_CLIENT) =="
  check "GET receptionist" 200 GET "/clients/${FIRST_CLIENT}/receptionist"
  check "GET knowledge-base" 200 GET "/clients/${FIRST_CLIENT}/knowledge-base"
  check "GET services" 200 GET "/clients/${FIRST_CLIENT}/services"
  check "GET staff" 200 GET "/clients/${FIRST_CLIENT}/staff"
  check "GET hours" 200 GET "/clients/${FIRST_CLIENT}/hours"
  check "GET booking" 200 GET "/clients/${FIRST_CLIENT}/booking"
  check "GET escalation" 200 GET "/clients/${FIRST_CLIENT}/escalation"
  check "GET calendar" 200 GET "/clients/${FIRST_CLIENT}/calendar"
else
  echo "  (no existing client to read per-client config from)"
fi

if [ "${RUN_WRITES:-0}" = "1" ]; then
  echo "== Writes (creating a TEST client) =="
  NEW=$(curl -sS -X POST "${hdr[@]}" -d '{"business_name":"ZZ Smoke Test Co","industry":"plumbing","is_test_client":true,"owner_name":"Smoke Test","email":"smoke+test@example.com"}' "${API}/clients")
  CID=$(printf '%s' "$NEW" | jq -r '.id // .data.id // .client.id // empty' 2>/dev/null)
  if [ -n "$CID" ]; then
    echo "  ok   created test client $CID"; PASS=$((PASS+1))
    check "POST service" 2xx POST "/clients/${CID}/services" '{"name":"Drain cleaning","price":150,"duration_minutes":60}'
    check "PATCH booking" 2xx PATCH "/clients/${CID}/booking" '{"min_notice_minutes":120}'
    check "DELETE test client" 2xx DELETE "/clients/${CID}"
  else
    echo "  FAIL could not create test client:"; printf '%s\n' "$NEW" | head -c 400; FAIL=$((FAIL+1))
  fi

  if [ -n "${WEBHOOK_URL:-}" ]; then
    echo "== Webhook register + ping =="
    WH=$(curl -sS -X POST "${hdr[@]}" -d "{\"url\":\"${WEBHOOK_URL}\",\"events\":[\"*\"]}" "${API}/webhooks")
    WID=$(printf '%s' "$WH" | jq -r '.id // .data.id // empty' 2>/dev/null)
    SECRET_PRESENT=$(printf '%s' "$WH" | jq -r 'if .secret then "yes" else "no" end' 2>/dev/null)
    if [ -n "$WID" ]; then
      echo "  ok   webhook $WID created (secret returned: ${SECRET_PRESENT})"; PASS=$((PASS+1))
      check "POST ping" 2xx POST "/webhooks/${WID}/ping"
      echo "  -> check ${WEBHOOK_URL} for the ping, and verify X-VoiceAI-Signature"
      check "GET deliveries" 200 GET "/webhooks/${WID}/deliveries"
      check "DELETE webhook" 2xx DELETE "/webhooks/${WID}"
    else
      echo "  FAIL could not create webhook:"; printf '%s\n' "$WH" | head -c 400; FAIL=$((FAIL+1))
    fi
  else
    echo "  (set WEBHOOK_URL to test webhook register + ping)"
  fi
else
  echo "== Writes skipped (set RUN_WRITES=1 to include create/update/delete + webhook) =="
fi

echo
echo "Passed: $PASS   Failed: $FAIL"
[ "$FAIL" = "0" ]
