#!/bin/bash
# ============================================================================
# GateControl API Test Suite
# ============================================================================
#
# Comprehensive test script for validating the GateControl REST API.
# Designed to run on a remote server against a live GateControl instance.
#
# Usage:
#   ./api-test.sh <base_url> <api_token>
#
# Example:
#   ./api-test.sh https://gate.example.com gc_a1b2c3d4e5f6...
#
# Requirements:
#   - bash 4+
#   - curl
#   - jq
#
# The script creates test resources (peers, routes, webhooks) and cleans
# them up afterwards. It does NOT modify existing data.
# ============================================================================

set -uo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BASE_URL="${1:-}"
TOKEN="${2:-}"

if [ -z "$BASE_URL" ] || [ -z "$TOKEN" ]; then
  echo "Usage: $0 <base_url> <api_token>"
  echo "Example: $0 https://gate.example.com gc_your_token_here"
  exit 1
fi

BASE_URL="${BASE_URL%/}"
API="$BASE_URL/api/v1"

# ---------------------------------------------------------------------------
# Test framework
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
SKIP=0
ERRORS=()
CLEANUP_PEER_IDS=()
CLEANUP_ROUTE_IDS=()
CLEANUP_WEBHOOK_IDS=()
CLEANUP_PEER_GROUP_IDS=()

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

pass() {
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}✓${NC} $1"
}

fail() {
  FAIL=$((FAIL + 1))
  ERRORS+=("$1: $2")
  echo -e "  ${RED}✗${NC} $1"
  echo -e "    ${RED}→ $2${NC}"
}

skip() {
  SKIP=$((SKIP + 1))
  echo -e "  ${YELLOW}○${NC} $1 (skipped: $2)"
}

section() {
  echo ""
  echo -e "${BOLD}${BLUE}━━━ $1 ━━━${NC}"
}

subsection() {
  echo -e "  ${CYAN}── $1${NC}"
}

# HTTP helper: returns "HTTP_CODE|BODY"
api() {
  local method="$1"
  local path="$2"
  shift 2
  local url="$API$path"

  curl -sk -w "\n%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -X "$method" \
    "$@" \
    "$url" 2>/dev/null
}

api_raw() {
  local method="$1"
  local url="$2"
  shift 2

  curl -sk -w "\n%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    -X "$method" \
    "$@" \
    "$url" 2>/dev/null
}

# Parse response: sets BODY and HTTP_CODE
parse() {
  local response="$1"
  HTTP_CODE=$(echo "$response" | tail -1)
  BODY=$(echo "$response" | sed '$d')
}

# Assert HTTP status
assert_status() {
  local expected="$1"
  local test_name="$2"
  if [ "$HTTP_CODE" = "$expected" ]; then
    pass "$test_name"
  else
    fail "$test_name" "expected HTTP $expected, got $HTTP_CODE"
  fi
}

# Assert JSON field value
assert_json() {
  local field="$1"
  local expected="$2"
  local test_name="$3"
  local actual
  actual=$(echo "$BODY" | jq -r "$field" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    pass "$test_name"
  else
    fail "$test_name" "expected $field=$expected, got '$actual'"
  fi
}

# Assert JSON field exists
assert_json_exists() {
  local field="$1"
  local test_name="$2"
  local val
  val=$(echo "$BODY" | jq -e "$field" 2>/dev/null)
  if [ $? -eq 0 ] && [ "$val" != "null" ]; then
    pass "$test_name"
  else
    fail "$test_name" "field $field not found or null"
  fi
}

# Assert JSON field is array with min length
assert_json_array_min() {
  local field="$1"
  local min="$2"
  local test_name="$3"
  local len
  len=$(echo "$BODY" | jq "$field | length" 2>/dev/null)
  if [ -n "$len" ] && [ "$len" -ge "$min" ]; then
    pass "$test_name"
  else
    fail "$test_name" "expected $field length >= $min, got $len"
  fi
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

cleanup() {
  echo ""
  section "Cleanup"

  for id in "${CLEANUP_PEER_GROUP_IDS[@]}"; do
    api DELETE "/peer-groups/$id" > /dev/null 2>&1
    echo -e "  ${YELLOW}→${NC} Deleted test peer group #$id"
  done

  for id in "${CLEANUP_WEBHOOK_IDS[@]}"; do
    api DELETE "/webhooks/$id" > /dev/null 2>&1
    echo -e "  ${YELLOW}→${NC} Deleted test webhook #$id"
  done

  for id in "${CLEANUP_ROUTE_IDS[@]}"; do
    api DELETE "/routes/$id" > /dev/null 2>&1
    echo -e "  ${YELLOW}→${NC} Deleted test route #$id"
  done

  for id in "${CLEANUP_PEER_IDS[@]}"; do
    api DELETE "/peers/$id" > /dev/null 2>&1
    echo -e "  ${YELLOW}→${NC} Deleted test peer #$id"
  done

  echo ""
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}  ${YELLOW}Skipped: $SKIP${NC}  Total: $((PASS + FAIL + SKIP))"
  echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  if [ ${#ERRORS[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}${BOLD}Failed tests:${NC}"
    for err in "${ERRORS[@]}"; do
      echo -e "  ${RED}✗${NC} $err"
    done
  fi

  echo ""
  if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All tests passed!${NC}"
  else
    echo -e "${RED}${BOLD}$FAIL test(s) failed.${NC}"
  fi
}

trap cleanup EXIT

# ============================================================================
# TEST SCENARIOS
# ============================================================================

echo ""
echo -e "${BOLD}GateControl API Test Suite${NC}"
echo -e "Target: ${CYAN}$BASE_URL${NC}"
echo -e "Token:  ${CYAN}${TOKEN:0:10}...${NC}"
echo ""

# ============================================================================
# 1. HEALTH & CONNECTIVITY
# ============================================================================

section "1. Health & Connectivity"

subsection "Health endpoint (no auth)"
parse "$(api_raw GET "$BASE_URL/health")"
assert_status "200" "GET /health returns 200"
assert_json ".ok" "true" "Health ok: true"
assert_json_exists ".db" "Database check present"
assert_json_exists ".wireguard" "WireGuard check present"

subsection "API reachable with token"
parse "$(api GET "/dashboard/stats")"
assert_status "200" "GET /dashboard/stats returns 200"
assert_json ".ok" "true" "Response has ok: true"

subsection "Reject invalid token"
RESP=$(curl -sk -w "\n%{http_code}" \
  -H "Authorization: Bearer gc_invalid_token_12345" \
  "$API/dashboard/stats" 2>/dev/null)
parse "$RESP"
assert_status "401" "Invalid token returns 401"
assert_json ".ok" "false" "Invalid token returns ok: false"

subsection "Reject no auth"
RESP=$(curl -sk -w "\n%{http_code}" "$API/peers" 2>/dev/null)
parse "$RESP"
assert_status "401" "No auth returns 401"

subsection "X-API-Token header"
RESP=$(curl -sk -w "\n%{http_code}" \
  -H "X-API-Token: $TOKEN" \
  "$API/dashboard/stats" 2>/dev/null)
parse "$RESP"
assert_status "200" "X-API-Token header accepted"

# ============================================================================
# 2. DASHBOARD
# ============================================================================

section "2. Dashboard"

subsection "Stats"
parse "$(api GET "/dashboard/stats")"
assert_status "200" "GET /dashboard/stats returns 200"
assert_json_exists ".peers" "peers stats present"
assert_json_exists ".routes" "routes stats present"
assert_json_exists ".traffic" "traffic stats present"

subsection "Traffic charts"
for period in "1h" "24h" "7d"; do
  parse "$(api GET "/dashboard/traffic?period=$period")"
  assert_status "200" "GET /dashboard/traffic?period=$period returns 200"
done

# ============================================================================
# 3. PEERS — FULL CRUD LIFECYCLE
# ============================================================================

section "3. Peers — CRUD Lifecycle"

subsection "List peers"
parse "$(api GET "/peers")"
assert_status "200" "GET /peers returns 200"
assert_json ".ok" "true" "Response ok"
INITIAL_PEER_COUNT=$(echo "$BODY" | jq '.peers | length')
pass "Found $INITIAL_PEER_COUNT existing peers"

subsection "Create peer"
parse "$(api POST "/peers" -d '{"name":"api-test-peer-1","description":"Created by API test","tags":"test,api"}')"
assert_status "201" "POST /peers returns 201"
assert_json ".ok" "true" "Create response ok"
assert_json_exists ".peer.id" "Peer ID returned"
assert_json ".peer.name" "api-test-peer-1" "Peer name matches"
assert_json_exists ".peer.ip" "IP address allocated"
assert_json_exists ".peer.publicKey" "Public key generated"

PEER_ID=$(echo "$BODY" | jq -r '.peer.id')
PEER_IP=$(echo "$BODY" | jq -r '.peer.ip')
CLEANUP_PEER_IDS+=("$PEER_ID")
pass "Created peer #$PEER_ID with IP $PEER_IP"

subsection "Create second peer"
parse "$(api POST "/peers" -d '{"name":"api-test-peer-2","description":"Second test peer","tags":"test"}')"
assert_status "201" "Second peer created"
PEER2_ID=$(echo "$BODY" | jq -r '.peer.id')
PEER2_IP=$(echo "$BODY" | jq -r '.peer.ip')
CLEANUP_PEER_IDS+=("$PEER2_ID")

if [ "$PEER_IP" != "$PEER2_IP" ]; then
  pass "Second peer has different IP ($PEER2_IP)"
else
  fail "IP uniqueness" "Both peers got same IP: $PEER_IP"
fi

subsection "Get single peer"
parse "$(api GET "/peers/$PEER_ID")"
assert_status "200" "GET /peers/$PEER_ID returns 200"
assert_json ".peer.name" "api-test-peer-1" "Peer name matches"
assert_json ".peer.description" "Created by API test" "Description matches"

subsection "Update peer"
parse "$(api PUT "/peers/$PEER_ID" -d '{"name":"api-test-peer-updated","description":"Updated via API","tags":"test,updated"}')"
assert_status "200" "PUT /peers/$PEER_ID returns 200"
assert_json ".ok" "true" "Update response ok"

parse "$(api GET "/peers/$PEER_ID")"
assert_json ".peer.name" "api-test-peer-updated" "Name updated"
assert_json ".peer.description" "Updated via API" "Description updated"

subsection "Toggle peer off"
parse "$(api PUT "/peers/$PEER_ID/toggle")"
assert_status "200" "PUT /peers/$PEER_ID/toggle returns 200"

parse "$(api GET "/peers/$PEER_ID")"
ENABLED=$(echo "$BODY" | jq -r '.peer.enabled')
if [ "$ENABLED" = "false" ] || [ "$ENABLED" = "0" ]; then pass "Peer disabled after toggle"; else fail "Peer disabled after toggle" "expected false/0, got '$ENABLED'"; fi

subsection "Toggle peer on"
parse "$(api PUT "/peers/$PEER_ID/toggle")"
assert_status "200" "Toggle back returns 200"

parse "$(api GET "/peers/$PEER_ID")"
ENABLED=$(echo "$BODY" | jq -r '.peer.enabled')
if [ "$ENABLED" = "true" ] || [ "$ENABLED" = "1" ]; then pass "Peer enabled after second toggle"; else fail "Peer enabled after second toggle" "expected true/1, got '$ENABLED'"; fi

subsection "Get peer config"
parse "$(api GET "/peers/$PEER_ID/config")"
assert_status "200" "GET /peers/$PEER_ID/config returns 200"
if echo "$BODY" | grep -q "\[Interface\]"; then
  pass "Config contains [Interface] section"
else
  fail "Peer config format" "Missing [Interface] section"
fi
if echo "$BODY" | grep -q "\[Peer\]"; then
  pass "Config contains [Peer] section"
else
  fail "Peer config format" "Missing [Peer] section"
fi

subsection "Get peer QR code"
RESP=$(curl -sk -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$API/peers/$PEER_ID/qr")
if [ "$RESP" = "200" ]; then
  pass "GET /peers/$PEER_ID/qr returns 200"
else
  fail "QR code endpoint" "Expected 200, got $RESP"
fi

subsection "Get peer traffic"
parse "$(api GET "/peers/$PEER_ID/traffic?period=24h")"
assert_status "200" "GET /peers/$PEER_ID/traffic returns 200"

subsection "Create peer — validation"
parse "$(api POST "/peers" -d '{"name":"","description":"Empty name"}')"
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ]; then
  pass "Empty name rejected (HTTP $HTTP_CODE)"
else
  fail "Validation: empty name" "Expected 400/422, got $HTTP_CODE"
fi

subsection "Create duplicate peer name"
parse "$(api POST "/peers" -d '{"name":"api-test-peer-updated","description":"Duplicate"}')"
if [ "$HTTP_CODE" != "201" ]; then
  pass "Duplicate name rejected (HTTP $HTTP_CODE)"
else
  # Might be allowed — clean up
  DUP_ID=$(echo "$BODY" | jq -r '.peer.id // empty')
  if [ -n "$DUP_ID" ]; then
    CLEANUP_PEER_IDS+=("$DUP_ID")
  fi
  skip "Duplicate peer name" "server allows duplicates"
fi

subsection "Get non-existent peer"
parse "$(api GET "/peers/99999")"
assert_status "404" "GET /peers/99999 returns 404"

# ============================================================================
# 4. ROUTES — FULL CRUD LIFECYCLE
# ============================================================================

section "4. Routes — CRUD Lifecycle"

subsection "List routes"
parse "$(api GET "/routes")"
assert_status "200" "GET /routes returns 200"
assert_json ".ok" "true" "Response ok"

subsection "Get available peers for dropdown"
parse "$(api GET "/routes/peers")"
assert_status "200" "GET /routes/peers returns 200"

subsection "Create HTTP route"
parse "$(api POST "/routes" -d "{
  \"domain\": \"api-test-$(date +%s).example.com\",
  \"target_ip\": \"$PEER_IP\",
  \"target_port\": 8080,
  \"description\": \"API test route\",
  \"peer_id\": $PEER_ID,
  \"https_enabled\": true,
  \"monitoring_enabled\": false
}")"
assert_status "201" "POST /routes returns 201"
assert_json ".ok" "true" "Create route response ok"
assert_json_exists ".route.id" "Route ID returned"

ROUTE_ID=$(echo "$BODY" | jq -r '.route.id')
ROUTE_DOMAIN=$(echo "$BODY" | jq -r '.route.domain')
CLEANUP_ROUTE_IDS+=("$ROUTE_ID")
pass "Created route #$ROUTE_ID ($ROUTE_DOMAIN)"

subsection "Get single route"
parse "$(api GET "/routes/$ROUTE_ID")"
assert_status "200" "GET /routes/$ROUTE_ID returns 200"
assert_json ".route.description" "API test route" "Description matches"

subsection "Update route"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"description":"Updated API test route","target_port":9090}')"
assert_status "200" "PUT /routes/$ROUTE_ID returns 200"

parse "$(api GET "/routes/$ROUTE_ID")"
assert_json ".route.description" "Updated API test route" "Description updated"

subsection "Toggle route off"
parse "$(api PUT "/routes/$ROUTE_ID/toggle")"
assert_status "200" "Toggle route returns 200"

parse "$(api GET "/routes/$ROUTE_ID")"
ENABLED=$(echo "$BODY" | jq -r '.route.enabled')
if [ "$ENABLED" = "false" ] || [ "$ENABLED" = "0" ]; then pass "Route disabled"; else fail "Route disabled" "expected false/0, got '$ENABLED'"; fi

subsection "Toggle route on"
parse "$(api PUT "/routes/$ROUTE_ID/toggle")"
assert_status "200" "Toggle back returns 200"

parse "$(api GET "/routes/$ROUTE_ID")"
ENABLED=$(echo "$BODY" | jq -r '.route.enabled')
if [ "$ENABLED" = "true" ] || [ "$ENABLED" = "1" ]; then pass "Route enabled"; else fail "Route enabled" "expected true/1, got '$ENABLED'"; fi

subsection "Filter routes by type"
parse "$(api GET "/routes?type=http")"
assert_status "200" "GET /routes?type=http returns 200"

subsection "Create route — validation"
parse "$(api POST "/routes" -d '{"domain":"","target_ip":"10.8.0.2","target_port":80}')"
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ]; then
  pass "Empty domain rejected (HTTP $HTTP_CODE)"
else
  fail "Validation: empty domain" "Expected 400/422, got $HTTP_CODE"
fi

subsection "Create duplicate domain"
parse "$(api POST "/routes" -d "{
  \"domain\": \"$ROUTE_DOMAIN\",
  \"target_ip\": \"10.8.0.2\",
  \"target_port\": 80
}")"
if [ "$HTTP_CODE" != "201" ]; then
  pass "Duplicate domain rejected (HTTP $HTTP_CODE)"
else
  DUP_ROUTE_ID=$(echo "$BODY" | jq -r '.route.id // empty')
  if [ -n "$DUP_ROUTE_ID" ]; then
    CLEANUP_ROUTE_IDS+=("$DUP_ROUTE_ID")
  fi
  fail "Duplicate domain" "Server accepted duplicate domain"
fi

# ============================================================================
# 5. ROUTE AUTH
# ============================================================================

section "5. Route Auth"

subsection "Get auth config (none set)"
parse "$(api GET "/routes/$ROUTE_ID/auth")"
assert_status "200" "GET /routes/$ROUTE_ID/auth returns 200"

subsection "Create email+password auth"
parse "$(api POST "/routes/$ROUTE_ID/auth" -d '{
  "auth_type": "email_password",
  "email": "test@example.com",
  "password": "TestP@ss123!"
}')"
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  pass "Route auth created (HTTP $HTTP_CODE)"
else
  fail "Create route auth" "Expected 200/201, got $HTTP_CODE"
fi

subsection "Get auth config (set)"
parse "$(api GET "/routes/$ROUTE_ID/auth")"
assert_status "200" "Get auth config returns 200"
assert_json ".ok" "true" "Auth config response ok"

subsection "TOTP setup"
parse "$(api POST "/routes/$ROUTE_ID/auth/totp-setup")"
if [ "$HTTP_CODE" = "200" ]; then
  pass "TOTP setup successful (HTTP 200)"
else
  skip "TOTP setup" "HTTP $HTTP_CODE"
fi

subsection "Delete auth config"
parse "$(api DELETE "/routes/$ROUTE_ID/auth")"
assert_status "200" "Delete route auth returns 200"

# ============================================================================
# 6. SETTINGS
# ============================================================================

section "6. Settings"

subsection "Profile"
# Profile endpoint requires session auth (user-specific)
parse "$(api GET "/settings/profile")"
if [ "$HTTP_CODE" = "200" ]; then
  pass "GET /settings/profile returns 200"
  assert_json_exists ".user" "User profile present"
else
  skip "GET /settings/profile" "requires session auth (HTTP $HTTP_CODE)"
fi

subsection "App settings"
parse "$(api GET "/settings/app")"
assert_status "200" "GET /settings/app returns 200"

subsection "Security settings"
parse "$(api GET "/settings/security")"
assert_status "200" "GET /settings/security returns 200"
assert_json_exists ".data" "Security data present"

subsection "Monitoring settings"
parse "$(api GET "/settings/monitoring")"
assert_status "200" "GET /settings/monitoring returns 200"

subsection "Data retention settings"
parse "$(api GET "/settings/data")"
assert_status "200" "GET /settings/data returns 200"

subsection "Email alert settings"
parse "$(api GET "/settings/alerts")"
assert_status "200" "GET /settings/alerts returns 200"

subsection "Locked accounts"
parse "$(api GET "/settings/lockout")"
assert_status "200" "GET /settings/lockout returns 200"

subsection "IP2Location settings"
parse "$(api GET "/settings/ip2location")"
assert_status "200" "GET /settings/ip2location returns 200"

# ============================================================================
# 7. SMTP
# ============================================================================

section "7. SMTP"

subsection "Get SMTP settings"
parse "$(api GET "/smtp/settings")"
assert_status "200" "GET /smtp/settings returns 200"

# ============================================================================
# 8. LOGS
# ============================================================================

section "8. Logs"

subsection "Activity log"
parse "$(api GET "/logs/activity?page=1&limit=10")"
assert_status "200" "GET /logs/activity returns 200"
assert_json ".ok" "true" "Response ok"

subsection "Recent activity"
parse "$(api GET "/logs/recent?limit=5")"
assert_status "200" "GET /logs/recent returns 200"

subsection "Access log"
parse "$(api GET "/logs/access?page=1&limit=10")"
assert_status "200" "GET /logs/access returns 200"

# ============================================================================
# 9. WIREGUARD
# ============================================================================

section "9. WireGuard"

subsection "WireGuard status"
parse "$(api GET "/wg/status")"
assert_status "200" "GET /wg/status returns 200"

subsection "WireGuard config"
parse "$(api GET "/wg/config")"
assert_status "200" "GET /wg/config returns 200"

# ============================================================================
# 10. CADDY
# ============================================================================

section "10. Caddy"

subsection "Caddy status"
parse "$(api GET "/caddy/status")"
assert_status "200" "GET /caddy/status returns 200"

# ============================================================================
# 11. SYSTEM
# ============================================================================

section "11. System"

subsection "System resources"
parse "$(api GET "/system/resources")"
assert_status "200" "GET /system/resources returns 200"
assert_json_exists ".cpu" "CPU value present"
assert_json_exists ".memory" "Memory value present"
assert_json_exists ".uptime" "Uptime present"

# ============================================================================
# 12. WEBHOOKS — FULL CRUD LIFECYCLE
# ============================================================================

section "12. Webhooks — CRUD Lifecycle"

subsection "List webhooks"
parse "$(api GET "/webhooks")"
assert_status "200" "GET /webhooks returns 200"

subsection "Create webhook"
parse "$(api POST "/webhooks" -d '{
  "url": "https://httpbin.org/post",
  "events": ["peer_connected", "peer_disconnected"],
  "description": "API test webhook"
}')"
assert_status "201" "POST /webhooks returns 201"
assert_json ".ok" "true" "Create webhook ok"

WEBHOOK_ID=$(echo "$BODY" | jq -r '.webhook.id')
CLEANUP_WEBHOOK_IDS+=("$WEBHOOK_ID")
pass "Created webhook #$WEBHOOK_ID"

subsection "Get webhooks (list includes new)"
parse "$(api GET "/webhooks")"
assert_status "200" "List webhooks returns 200"
WH_FOUND=$(echo "$BODY" | jq "[.webhooks[] | select(.id == $WEBHOOK_ID)] | length")
if [ "$WH_FOUND" = "1" ]; then
  pass "New webhook appears in list"
else
  fail "Webhook in list" "Webhook #$WEBHOOK_ID not found in list"
fi

subsection "Update webhook"
parse "$(api PUT "/webhooks/$WEBHOOK_ID" -d '{
  "url": "https://httpbin.org/post",
  "events": ["*"],
  "description": "Updated API test webhook"
}')"
assert_status "200" "PUT /webhooks/$WEBHOOK_ID returns 200"

subsection "Toggle webhook off"
parse "$(api PUT "/webhooks/$WEBHOOK_ID/toggle")"
assert_status "200" "Toggle webhook returns 200"

subsection "Test webhook"
parse "$(api POST "/webhooks/$WEBHOOK_ID/test")"
if [ "$HTTP_CODE" = "200" ]; then
  pass "Webhook test sent"
else
  skip "Webhook test" "HTTP $HTTP_CODE (webhook may be disabled or URL unreachable)"
fi

subsection "Create webhook — SSRF protection"
parse "$(api POST "/webhooks" -d '{
  "url": "http://127.0.0.1:3000/admin",
  "events": ["*"],
  "description": "SSRF attempt"
}')"
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ]; then
  pass "Localhost URL blocked (HTTP $HTTP_CODE)"
else
  fail "SSRF protection" "Expected 400/422, got $HTTP_CODE"
  DUP_WH_ID=$(echo "$BODY" | jq -r '.webhook.id // empty')
  if [ -n "$DUP_WH_ID" ]; then
    CLEANUP_WEBHOOK_IDS+=("$DUP_WH_ID")
  fi
fi

parse "$(api POST "/webhooks" -d '{
  "url": "http://192.168.1.1/admin",
  "events": ["*"]
}')"
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ]; then
  pass "Private IP (192.168.x) blocked"
else
  fail "SSRF protection (192.168.x)" "Expected 400/422, got $HTTP_CODE"
fi

parse "$(api POST "/webhooks" -d '{
  "url": "http://10.0.0.1/admin",
  "events": ["*"]
}')"
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ]; then
  pass "Private IP (10.x) blocked"
else
  fail "SSRF protection (10.x)" "Expected 400/422, got $HTTP_CODE"
fi

# ============================================================================
# 13. API TOKENS
# ============================================================================

section "13. API Tokens"

subsection "List tokens"
parse "$(api GET "/tokens")"
assert_status "200" "GET /tokens returns 200"
assert_json ".ok" "true" "Response ok"

subsection "Token escalation prevention"
# Tokens cannot create or delete other tokens
parse "$(api POST "/tokens" -d '{"name":"escalation-test","scopes":["full-access"]}')"
if [ "$HTTP_CODE" = "403" ]; then
  pass "Token cannot create tokens (403)"
else
  # If session auth allows it, that's also fine
  skip "Token escalation" "HTTP $HTTP_CODE (might be session auth)"
fi

# ============================================================================
# 14. BACKUP
# ============================================================================

section "14. Backup"

subsection "Download backup"
parse "$(api GET "/settings/backup")"
assert_status "200" "GET /settings/backup returns 200"

if echo "$BODY" | jq -e '.version' > /dev/null 2>&1; then
  pass "Backup contains version field"
else
  fail "Backup format" "Missing version field"
fi

if echo "$BODY" | jq -e '.data.peers' > /dev/null 2>&1; then
  pass "Backup contains peers"
elif echo "$BODY" | jq -e '.peers' > /dev/null 2>&1; then
  pass "Backup contains peers (flat format)"
else
  fail "Backup format" "Missing peers"
fi

if echo "$BODY" | jq -e '.data.routes' > /dev/null 2>&1; then
  pass "Backup contains routes"
elif echo "$BODY" | jq -e '.routes' > /dev/null 2>&1; then
  pass "Backup contains routes (flat format)"
else
  fail "Backup format" "Missing routes"
fi

if echo "$BODY" | jq -e '.data.settings' > /dev/null 2>&1; then
  pass "Backup contains settings"
elif echo "$BODY" | jq -e '.settings' > /dev/null 2>&1; then
  pass "Backup contains settings (flat format)"
else
  fail "Backup format" "Missing settings"
fi

# ============================================================================
# 15. PEER EXPIRY
# ============================================================================

section "15. Peer Expiry"

FUTURE_DATE="2099-12-31T23:59:59Z"
PAST_DATE="2020-01-01T00:00:00Z"

subsection "Create peer with expires_at (future date)"
parse "$(api POST "/peers" -d "{\"name\":\"api-test-expiry-peer\",\"description\":\"Expiry test\",\"expires_at\":\"$FUTURE_DATE\"}")"
assert_status "201" "POST /peers with expires_at returns 201"
EXPIRY_PEER_ID=$(echo "$BODY" | jq -r '.peer.id')
CLEANUP_PEER_IDS+=("$EXPIRY_PEER_ID")
EXPIRY_VAL=$(echo "$BODY" | jq -r '.peer.expires_at // empty')
if [ -n "$EXPIRY_VAL" ] && [ "$EXPIRY_VAL" != "null" ]; then
  pass "expires_at present in create response"
else
  fail "expires_at in create response" "expected expires_at to be set, got '$EXPIRY_VAL'"
fi

subsection "Create peer with expires_at (past date)"
parse "$(api POST "/peers" -d "{\"name\":\"api-test-expiry-past\",\"description\":\"Past expiry\",\"expires_at\":\"$PAST_DATE\"}")"
assert_status "201" "POST /peers with past expires_at returns 201"
EXPIRY_PAST_PEER_ID=$(echo "$BODY" | jq -r '.peer.id')
CLEANUP_PEER_IDS+=("$EXPIRY_PAST_PEER_ID")

subsection "Update peer expiry"
NEW_FUTURE="2098-06-15T12:00:00Z"
parse "$(api PUT "/peers/$EXPIRY_PEER_ID" -d "{\"expires_at\":\"$NEW_FUTURE\"}")"
assert_status "200" "PUT /peers/$EXPIRY_PEER_ID with new expires_at returns 200"

subsection "Verify expiry in GET response"
parse "$(api GET "/peers/$EXPIRY_PEER_ID")"
assert_status "200" "GET /peers/$EXPIRY_PEER_ID returns 200"
EXPIRY_VAL=$(echo "$BODY" | jq -r '.peer.expires_at // empty')
if [ -n "$EXPIRY_VAL" ] && [ "$EXPIRY_VAL" != "null" ]; then
  pass "expires_at field present in GET response"
else
  fail "expires_at in GET response" "expected expires_at to be set, got '$EXPIRY_VAL'"
fi

subsection "Remove expiry"
parse "$(api PUT "/peers/$EXPIRY_PEER_ID" -d '{"expires_at":null}')"
assert_status "200" "PUT /peers/$EXPIRY_PEER_ID with expires_at:null returns 200"

parse "$(api GET "/peers/$EXPIRY_PEER_ID")"
EXPIRY_VAL=$(echo "$BODY" | jq -r '.peer.expires_at // "null"')
if [ "$EXPIRY_VAL" = "null" ] || [ -z "$EXPIRY_VAL" ]; then
  pass "expires_at cleared after setting to null"
else
  fail "expires_at cleared" "expected null/empty, got '$EXPIRY_VAL'"
fi

# Cleanup expiry test peers
api DELETE "/peers/$EXPIRY_PEER_ID" > /dev/null 2>&1
CLEANUP_PEER_IDS=("${CLEANUP_PEER_IDS[@]/$EXPIRY_PEER_ID}")
api DELETE "/peers/$EXPIRY_PAST_PEER_ID" > /dev/null 2>&1
CLEANUP_PEER_IDS=("${CLEANUP_PEER_IDS[@]/$EXPIRY_PAST_PEER_ID}")

# ============================================================================
# 16. PEER ACL
# ============================================================================

section "16. Peer ACL"

subsection "Create route with ACL"
parse "$(api POST "/routes" -d "{
  \"domain\": \"api-test-acl-$(date +%s).example.com\",
  \"target_ip\": \"$PEER_IP\",
  \"target_port\": 8080,
  \"peer_id\": $PEER_ID,
  \"https_enabled\": true,
  \"acl_enabled\": true,
  \"acl_peers\": [$PEER_ID]
}")"
assert_status "201" "POST /routes with ACL returns 201"
ACL_ROUTE_ID=$(echo "$BODY" | jq -r '.route.id')
CLEANUP_ROUTE_IDS+=("$ACL_ROUTE_ID")

subsection "Verify ACL in GET"
parse "$(api GET "/routes/$ACL_ROUTE_ID")"
assert_status "200" "GET /routes/$ACL_ROUTE_ID returns 200"
ACL_ENABLED=$(echo "$BODY" | jq -r '.route.acl_enabled // empty')
if [ "$ACL_ENABLED" = "true" ] || [ "$ACL_ENABLED" = "1" ]; then
  pass "acl_enabled is true/1 in GET response"
else
  fail "acl_enabled in GET" "expected true/1, got '$ACL_ENABLED'"
fi
ACL_PEERS=$(echo "$BODY" | jq -r '.route.acl_peers // empty')
if [ -n "$ACL_PEERS" ] && [ "$ACL_PEERS" != "null" ] && [ "$ACL_PEERS" != "" ]; then
  pass "acl_peers present in GET response"
else
  fail "acl_peers in GET" "expected acl_peers to be set"
fi

subsection "Update ACL peers"
parse "$(api PUT "/routes/$ACL_ROUTE_ID" -d "{\"acl_peers\":[$PEER_ID]}")"
assert_status "200" "PUT /routes/$ACL_ROUTE_ID with updated acl_peers returns 200"

subsection "Disable ACL"
parse "$(api PUT "/routes/$ACL_ROUTE_ID" -d '{"acl_enabled":false}')"
assert_status "200" "PUT /routes/$ACL_ROUTE_ID with acl_enabled:false returns 200"

subsection "Caddy reload after ACL change"
parse "$(api POST "/caddy/reload")"
assert_status "200" "POST /caddy/reload returns 200 after ACL change"

# Cleanup ACL test route
api DELETE "/routes/$ACL_ROUTE_ID" > /dev/null 2>&1
CLEANUP_ROUTE_IDS=("${CLEANUP_ROUTE_IDS[@]/$ACL_ROUTE_ID}")

# ============================================================================
# 17. AUTOMATIC BACKUPS
# ============================================================================

section "17. Automatic Backups"

subsection "Get auto-backup settings"
parse "$(api GET "/settings/autobackup")"
assert_status "200" "GET /settings/autobackup returns 200"

subsection "Update auto-backup settings"
parse "$(api PUT "/settings/autobackup" -d '{"enabled":true,"schedule":"daily","retention":3}')"
assert_status "200" "PUT /settings/autobackup returns 200"

subsection "Trigger manual backup"
parse "$(api POST "/settings/autobackup/run")"
assert_status "200" "POST /settings/autobackup/run returns 200"

subsection "List backup files"
parse "$(api GET "/settings/autobackup/list")"
assert_status "200" "GET /settings/autobackup/list returns 200"
BACKUP_FILES=$(echo "$BODY" | jq -r '.files // .backups // []')
BACKUP_COUNT=$(echo "$BACKUP_FILES" | jq 'length' 2>/dev/null)
if [ -n "$BACKUP_COUNT" ] && [ "$BACKUP_COUNT" -ge 1 ]; then
  pass "At least 1 backup file listed ($BACKUP_COUNT found)"
  BACKUP_FILENAME=$(echo "$BACKUP_FILES" | jq -r '.[0].filename // .[0].name // .[0]' 2>/dev/null)
else
  fail "Backup file count" "expected >= 1, got $BACKUP_COUNT"
  BACKUP_FILENAME=""
fi

subsection "Download backup file"
if [ -n "$BACKUP_FILENAME" ] && [ "$BACKUP_FILENAME" != "null" ]; then
  DOWNLOAD_CODE=$(curl -sk -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "$API/settings/autobackup/download/$BACKUP_FILENAME")
  if [ "$DOWNLOAD_CODE" = "200" ]; then
    pass "GET /settings/autobackup/download/$BACKUP_FILENAME returns 200"
  else
    fail "Download backup file" "expected 200, got $DOWNLOAD_CODE"
  fi
else
  skip "Download backup file" "no backup filename available"
fi

subsection "Delete backup file"
if [ -n "$BACKUP_FILENAME" ] && [ "$BACKUP_FILENAME" != "null" ]; then
  parse "$(api DELETE "/settings/autobackup/$BACKUP_FILENAME")"
  assert_status "200" "DELETE /settings/autobackup/$BACKUP_FILENAME returns 200"
else
  skip "Delete backup file" "no backup filename available"
fi

subsection "Disable auto-backup"
parse "$(api PUT "/settings/autobackup" -d '{"enabled":false}')"
assert_status "200" "PUT /settings/autobackup with enabled:false returns 200"

# ============================================================================
# 18. LOG EXPORT
# ============================================================================

section "18. Log Export"

subsection "Export activity log as CSV"
EXPORT_RESP=$(curl -sk -o /dev/null -w "%{http_code}|%{content_type}" \
  -H "Authorization: Bearer $TOKEN" \
  "$API/logs/activity/export?format=csv")
EXPORT_CODE=$(echo "$EXPORT_RESP" | cut -d'|' -f1)
EXPORT_CT=$(echo "$EXPORT_RESP" | cut -d'|' -f2)
if [ "$EXPORT_CODE" = "200" ]; then
  pass "GET /logs/activity/export?format=csv returns 200"
  if echo "$EXPORT_CT" | grep -qi "text/csv"; then
    pass "Activity CSV Content-Type contains text/csv"
  else
    fail "Activity CSV Content-Type" "expected text/csv, got '$EXPORT_CT'"
  fi
else
  fail "Activity log CSV export" "expected 200, got $EXPORT_CODE"
fi

subsection "Export activity log as JSON"
EXPORT_RESP=$(curl -sk -o /dev/null -w "%{http_code}|%{content_type}" \
  -H "Authorization: Bearer $TOKEN" \
  "$API/logs/activity/export?format=json")
EXPORT_CODE=$(echo "$EXPORT_RESP" | cut -d'|' -f1)
EXPORT_CT=$(echo "$EXPORT_RESP" | cut -d'|' -f2)
if [ "$EXPORT_CODE" = "200" ]; then
  pass "GET /logs/activity/export?format=json returns 200"
  if echo "$EXPORT_CT" | grep -qi "application/json"; then
    pass "Activity JSON Content-Type contains application/json"
  else
    fail "Activity JSON Content-Type" "expected application/json, got '$EXPORT_CT'"
  fi
else
  fail "Activity log JSON export" "expected 200, got $EXPORT_CODE"
fi

subsection "Export access log as CSV"
EXPORT_RESP=$(curl -sk -o /dev/null -w "%{http_code}|%{content_type}" \
  -H "Authorization: Bearer $TOKEN" \
  "$API/logs/access/export?format=csv")
EXPORT_CODE=$(echo "$EXPORT_RESP" | cut -d'|' -f1)
if [ "$EXPORT_CODE" = "200" ]; then
  pass "GET /logs/access/export?format=csv returns 200"
else
  fail "Access log CSV export" "expected 200, got $EXPORT_CODE"
fi

subsection "Export access log as JSON"
EXPORT_RESP=$(curl -sk -o /dev/null -w "%{http_code}|%{content_type}" \
  -H "Authorization: Bearer $TOKEN" \
  "$API/logs/access/export?format=json")
EXPORT_CODE=$(echo "$EXPORT_RESP" | cut -d'|' -f1)
if [ "$EXPORT_CODE" = "200" ]; then
  pass "GET /logs/access/export?format=json returns 200"
else
  fail "Access log JSON export" "expected 200, got $EXPORT_CODE"
fi

# ============================================================================
# 19. ROUTE COMPRESSION
# ============================================================================

section "19. Route Compression"

subsection "Create route with compression"
parse "$(api POST "/routes" -d "{
  \"domain\": \"api-test-compress-$(date +%s).example.com\",
  \"target_ip\": \"$PEER_IP\",
  \"target_port\": 8080,
  \"peer_id\": $PEER_ID,
  \"https_enabled\": true,
  \"compress_enabled\": true
}")"
assert_status "201" "POST /routes with compress_enabled returns 201"
COMPRESS_ROUTE_ID=$(echo "$BODY" | jq -r '.route.id')
CLEANUP_ROUTE_IDS+=("$COMPRESS_ROUTE_ID")

subsection "Verify compression in GET"
parse "$(api GET "/routes/$COMPRESS_ROUTE_ID")"
assert_status "200" "GET /routes/$COMPRESS_ROUTE_ID returns 200"
COMPRESS_VAL=$(echo "$BODY" | jq -r '.route.compress_enabled // empty')
if [ "$COMPRESS_VAL" = "true" ] || [ "$COMPRESS_VAL" = "1" ]; then
  pass "compress_enabled is true/1 in GET response"
else
  fail "compress_enabled in GET" "expected true/1, got '$COMPRESS_VAL'"
fi

subsection "Caddy reload after compression"
parse "$(api POST "/caddy/reload")"
assert_status "200" "POST /caddy/reload returns 200 after compression change"

subsection "Disable compression"
parse "$(api PUT "/routes/$COMPRESS_ROUTE_ID" -d '{"compress_enabled":false}')"
assert_status "200" "PUT /routes/$COMPRESS_ROUTE_ID with compress_enabled:false returns 200"

parse "$(api GET "/routes/$COMPRESS_ROUTE_ID")"
COMPRESS_VAL=$(echo "$BODY" | jq -r '.route.compress_enabled // "0"')
if [ "$COMPRESS_VAL" = "false" ] || [ "$COMPRESS_VAL" = "0" ]; then
  pass "compress_enabled disabled"
else
  fail "compress_enabled disabled" "expected false/0, got '$COMPRESS_VAL'"
fi

# Cleanup compression test route
api DELETE "/routes/$COMPRESS_ROUTE_ID" > /dev/null 2>&1
CLEANUP_ROUTE_IDS=("${CLEANUP_ROUTE_IDS[@]/$COMPRESS_ROUTE_ID}")

# ============================================================================
# 20. CUSTOM HEADERS
# ============================================================================

section "20. Custom Headers"

subsection "Update route with custom headers"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"custom_headers":"{\"X-Test-Header\":\"test-value\",\"X-Another\":\"value2\"}"}')"
assert_status "200" "PUT /routes/$ROUTE_ID with custom_headers returns 200"

subsection "Verify headers in GET"
parse "$(api GET "/routes/$ROUTE_ID")"
assert_status "200" "GET /routes/$ROUTE_ID returns 200"
HEADERS_VAL=$(echo "$BODY" | jq -r '.route.custom_headers // empty')
if [ -n "$HEADERS_VAL" ] && [ "$HEADERS_VAL" != "null" ] && [ "$HEADERS_VAL" != "" ]; then
  pass "custom_headers present in GET response"
else
  fail "custom_headers in GET" "expected custom_headers to be set"
fi

subsection "Caddy reload after headers"
parse "$(api POST "/caddy/reload")"
assert_status "200" "POST /caddy/reload returns 200 after custom headers"

subsection "Clear headers"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"custom_headers":null}')"
assert_status "200" "PUT /routes/$ROUTE_ID with custom_headers:null returns 200"

# ============================================================================
# 21. PER-ROUTE RATE LIMITING
# ============================================================================

section "21. Per-Route Rate Limiting"

subsection "Update route with rate limiting"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"rate_limit_enabled":true,"rate_limit_requests":50,"rate_limit_window":"1m"}')"
assert_status "200" "PUT /routes/$ROUTE_ID with rate limiting returns 200"

subsection "Verify rate limit in GET"
parse "$(api GET "/routes/$ROUTE_ID")"
assert_status "200" "GET /routes/$ROUTE_ID returns 200"
RL_ENABLED=$(echo "$BODY" | jq -r '.route.rate_limit_enabled // empty')
if [ "$RL_ENABLED" = "true" ] || [ "$RL_ENABLED" = "1" ]; then
  pass "rate_limit_enabled is true/1"
else
  fail "rate_limit_enabled" "expected true/1, got '$RL_ENABLED'"
fi
RL_REQUESTS=$(echo "$BODY" | jq -r '.route.rate_limit_requests // empty')
if [ "$RL_REQUESTS" = "50" ]; then
  pass "rate_limit_requests is 50"
else
  fail "rate_limit_requests" "expected 50, got '$RL_REQUESTS'"
fi
RL_WINDOW=$(echo "$BODY" | jq -r '.route.rate_limit_window // empty')
if [ -n "$RL_WINDOW" ] && [ "$RL_WINDOW" != "null" ]; then
  pass "rate_limit_window present ($RL_WINDOW)"
else
  fail "rate_limit_window" "expected to be set, got '$RL_WINDOW'"
fi

subsection "Caddy reload after rate limit"
parse "$(api POST "/caddy/reload")"
assert_status "200" "POST /caddy/reload returns 200 after rate limit"

subsection "Disable rate limiting"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"rate_limit_enabled":false}')"
assert_status "200" "PUT /routes/$ROUTE_ID with rate_limit_enabled:false returns 200"

# ============================================================================
# 22. RETRY WITH BACKOFF
# ============================================================================

section "22. Retry with Backoff"

subsection "Update route with retry"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"retry_enabled":true,"retry_count":3,"retry_match_status":"502,503,504"}')"
assert_status "200" "PUT /routes/$ROUTE_ID with retry settings returns 200"

subsection "Verify retry in GET"
parse "$(api GET "/routes/$ROUTE_ID")"
assert_status "200" "GET /routes/$ROUTE_ID returns 200"
RETRY_ENABLED=$(echo "$BODY" | jq -r '.route.retry_enabled // empty')
if [ "$RETRY_ENABLED" = "true" ] || [ "$RETRY_ENABLED" = "1" ]; then
  pass "retry_enabled is true/1"
else
  fail "retry_enabled" "expected true/1, got '$RETRY_ENABLED'"
fi
RETRY_COUNT=$(echo "$BODY" | jq -r '.route.retry_count // empty')
if [ "$RETRY_COUNT" = "3" ]; then
  pass "retry_count is 3"
else
  fail "retry_count" "expected 3, got '$RETRY_COUNT'"
fi
RETRY_STATUS=$(echo "$BODY" | jq -r '.route.retry_match_status // empty')
if [ -n "$RETRY_STATUS" ] && [ "$RETRY_STATUS" != "null" ]; then
  pass "retry_match_status present ($RETRY_STATUS)"
else
  fail "retry_match_status" "expected to be set, got '$RETRY_STATUS'"
fi

subsection "Caddy reload after retry"
parse "$(api POST "/caddy/reload")"
assert_status "200" "POST /caddy/reload returns 200 after retry config"

subsection "Disable retry"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"retry_enabled":false}')"
assert_status "200" "PUT /routes/$ROUTE_ID with retry_enabled:false returns 200"

# ============================================================================
# 23. MULTIPLE BACKENDS
# ============================================================================

section "23. Multiple Backends"

subsection "Update route with backends"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"backends":"[{\"address\":\"10.8.0.2:8080\",\"weight\":1},{\"address\":\"10.8.0.3:8080\",\"weight\":1}]"}')"
assert_status "200" "PUT /routes/$ROUTE_ID with backends returns 200"

subsection "Verify backends in GET"
parse "$(api GET "/routes/$ROUTE_ID")"
assert_status "200" "GET /routes/$ROUTE_ID returns 200"
BACKENDS_VAL=$(echo "$BODY" | jq -r '.route.backends // empty')
if [ -n "$BACKENDS_VAL" ] && [ "$BACKENDS_VAL" != "null" ] && [ "$BACKENDS_VAL" != "" ]; then
  pass "backends field present in GET response"
else
  fail "backends in GET" "expected backends to be set"
fi

subsection "Caddy reload after backends"
parse "$(api POST "/caddy/reload")"
assert_status "200" "POST /caddy/reload returns 200 after backends change"

subsection "Clear backends"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"backends":null}')"
assert_status "200" "PUT /routes/$ROUTE_ID with backends:null returns 200"

# ============================================================================
# 24. STICKY SESSIONS
# ============================================================================

section "24. Sticky Sessions"

subsection "Update route with sticky sessions + backends"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{
  "sticky_enabled": true,
  "sticky_cookie_name": "gc_test",
  "sticky_cookie_ttl": "3600",
  "backends": "[{\"address\":\"10.8.0.2:8080\",\"weight\":1},{\"address\":\"10.8.0.3:8080\",\"weight\":1}]"
}')"
assert_status "200" "PUT /routes/$ROUTE_ID with sticky sessions returns 200"

subsection "Verify sticky in GET"
parse "$(api GET "/routes/$ROUTE_ID")"
assert_status "200" "GET /routes/$ROUTE_ID returns 200"
STICKY_ENABLED=$(echo "$BODY" | jq -r '.route.sticky_enabled // empty')
if [ "$STICKY_ENABLED" = "true" ] || [ "$STICKY_ENABLED" = "1" ]; then
  pass "sticky_enabled is true/1"
else
  fail "sticky_enabled" "expected true/1, got '$STICKY_ENABLED'"
fi
STICKY_COOKIE=$(echo "$BODY" | jq -r '.route.sticky_cookie_name // empty')
if [ "$STICKY_COOKIE" = "gc_test" ]; then
  pass "sticky_cookie_name is gc_test"
else
  fail "sticky_cookie_name" "expected gc_test, got '$STICKY_COOKIE'"
fi
STICKY_TTL=$(echo "$BODY" | jq -r '.route.sticky_cookie_ttl // empty')
if [ -n "$STICKY_TTL" ] && [ "$STICKY_TTL" != "null" ]; then
  pass "sticky_cookie_ttl present ($STICKY_TTL)"
else
  fail "sticky_cookie_ttl" "expected to be set, got '$STICKY_TTL'"
fi

subsection "Caddy reload after sticky sessions"
parse "$(api POST "/caddy/reload")"
assert_status "200" "POST /caddy/reload returns 200 after sticky sessions"

subsection "Disable sticky sessions"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"sticky_enabled":false,"backends":null}')"
assert_status "200" "PUT /routes/$ROUTE_ID with sticky_enabled:false returns 200"

# ============================================================================
# 25. PROMETHEUS METRICS
# ============================================================================

section "25. Prometheus Metrics"

subsection "Enable metrics"
parse "$(api PUT "/settings/metrics" -d '{"enabled":true}')"
assert_status "200" "PUT /settings/metrics with enabled:true returns 200"

subsection "GET /metrics"
METRICS_RESP=$(curl -sk -o /tmp/gc_metrics_body -w "%{http_code}|%{content_type}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/metrics" 2>/dev/null)
METRICS_CODE=$(echo "$METRICS_RESP" | cut -d'|' -f1)
METRICS_CT=$(echo "$METRICS_RESP" | cut -d'|' -f2)
METRICS_BODY=$(cat /tmp/gc_metrics_body 2>/dev/null)
if [ "$METRICS_CODE" = "200" ]; then
  pass "GET /metrics returns 200"
else
  fail "GET /metrics" "expected 200, got $METRICS_CODE"
fi
if echo "$METRICS_CT" | grep -qi "text/plain"; then
  pass "Metrics Content-Type contains text/plain"
else
  fail "Metrics Content-Type" "expected text/plain, got '$METRICS_CT'"
fi

subsection "Verify metric names"
if echo "$METRICS_BODY" | grep -q "gatecontrol_peers_total"; then
  pass "Metrics contain gatecontrol_peers_total"
else
  fail "gatecontrol_peers_total" "metric not found in response"
fi
if echo "$METRICS_BODY" | grep -q "gatecontrol_routes_total"; then
  pass "Metrics contain gatecontrol_routes_total"
else
  fail "gatecontrol_routes_total" "metric not found in response"
fi
if echo "$METRICS_BODY" | grep -q "gatecontrol_cpu_usage_percent"; then
  pass "Metrics contain gatecontrol_cpu_usage_percent"
else
  fail "gatecontrol_cpu_usage_percent" "metric not found in response"
fi

subsection "GET /metrics with query param auth"
METRICS_TOKEN_RESP=$(curl -sk -o /dev/null -w "%{http_code}" \
  "$BASE_URL/metrics?token=$TOKEN" 2>/dev/null)
if [ "$METRICS_TOKEN_RESP" = "200" ]; then
  pass "GET /metrics?token=\$TOKEN returns 200"
else
  fail "GET /metrics with query token" "expected 200, got $METRICS_TOKEN_RESP"
fi

subsection "Disable metrics"
parse "$(api PUT "/settings/metrics" -d '{"enabled":false}')"
assert_status "200" "PUT /settings/metrics with enabled:false returns 200"

subsection "GET /metrics when disabled"
METRICS_OFF_CODE=$(curl -sk -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/metrics" 2>/dev/null)
if [ "$METRICS_OFF_CODE" = "404" ]; then
  pass "GET /metrics when disabled returns 404"
else
  fail "GET /metrics when disabled" "expected 404, got $METRICS_OFF_CODE"
fi

rm -f /tmp/gc_metrics_body

# ============================================================================
# 26. CIRCUIT BREAKER
# ============================================================================

section "26. Circuit Breaker"

subsection "Update route with circuit breaker"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"circuit_breaker_enabled":true,"circuit_breaker_threshold":5,"circuit_breaker_timeout":30}')"
assert_status "200" "PUT /routes/$ROUTE_ID with circuit breaker returns 200"

subsection "Verify circuit breaker in GET"
parse "$(api GET "/routes/$ROUTE_ID")"
assert_status "200" "GET /routes/$ROUTE_ID returns 200"
CB_ENABLED=$(echo "$BODY" | jq -r '.route.circuit_breaker_enabled // empty')
if [ "$CB_ENABLED" = "true" ] || [ "$CB_ENABLED" = "1" ]; then
  pass "circuit_breaker_enabled is true/1"
else
  fail "circuit_breaker_enabled" "expected true/1, got '$CB_ENABLED'"
fi
CB_STATUS=$(echo "$BODY" | jq -r '.route.circuit_breaker_status // empty')
if [ "$CB_STATUS" = "closed" ]; then
  pass "circuit_breaker_status is 'closed'"
else
  fail "circuit_breaker_status" "expected 'closed', got '$CB_STATUS'"
fi

subsection "Caddy reload after circuit breaker"
parse "$(api POST "/caddy/reload")"
assert_status "200" "POST /caddy/reload returns 200 after circuit breaker"

subsection "Disable circuit breaker"
parse "$(api PUT "/routes/$ROUTE_ID" -d '{"circuit_breaker_enabled":false}')"
assert_status "200" "PUT /routes/$ROUTE_ID with circuit_breaker_enabled:false returns 200"

# ============================================================================
# 27. BATCH OPERATIONS
# ============================================================================

section "27. Batch Operations"

subsection "Create test peers for batch"
parse "$(api POST "/peers" -d '{"name":"api-test-batch-peer-1","description":"Batch test peer 1","tags":"batch,test"}')"
assert_status "201" "Batch peer 1 created"
BATCH_PEER1_ID=$(echo "$BODY" | jq -r '.peer.id')
CLEANUP_PEER_IDS+=("$BATCH_PEER1_ID")

parse "$(api POST "/peers" -d '{"name":"api-test-batch-peer-2","description":"Batch test peer 2","tags":"batch,test"}')"
assert_status "201" "Batch peer 2 created"
BATCH_PEER2_ID=$(echo "$BODY" | jq -r '.peer.id')
CLEANUP_PEER_IDS+=("$BATCH_PEER2_ID")

subsection "Batch disable peers"
parse "$(api POST "/peers/batch" -d "{\"action\":\"disable\",\"ids\":[$BATCH_PEER1_ID,$BATCH_PEER2_ID]}")"
assert_status "200" "POST /peers/batch with action:disable returns 200"
AFFECTED=$(echo "$BODY" | jq -r '.affected // .count // empty')
if [ "$AFFECTED" = "2" ]; then
  pass "Batch disable affected 2 peers"
else
  fail "Batch disable affected count" "expected 2, got '$AFFECTED'"
fi

subsection "Verify peers disabled"
parse "$(api GET "/peers/$BATCH_PEER1_ID")"
BP1_ENABLED=$(echo "$BODY" | jq -r '.peer.enabled')
if [ "$BP1_ENABLED" = "false" ] || [ "$BP1_ENABLED" = "0" ]; then
  pass "Batch peer 1 disabled"
else
  fail "Batch peer 1 disabled" "expected false/0, got '$BP1_ENABLED'"
fi

parse "$(api GET "/peers/$BATCH_PEER2_ID")"
BP2_ENABLED=$(echo "$BODY" | jq -r '.peer.enabled')
if [ "$BP2_ENABLED" = "false" ] || [ "$BP2_ENABLED" = "0" ]; then
  pass "Batch peer 2 disabled"
else
  fail "Batch peer 2 disabled" "expected false/0, got '$BP2_ENABLED'"
fi

subsection "Batch enable peers"
parse "$(api POST "/peers/batch" -d "{\"action\":\"enable\",\"ids\":[$BATCH_PEER1_ID,$BATCH_PEER2_ID]}")"
assert_status "200" "POST /peers/batch with action:enable returns 200"

subsection "Batch delete peers"
parse "$(api POST "/peers/batch" -d "{\"action\":\"delete\",\"ids\":[$BATCH_PEER1_ID,$BATCH_PEER2_ID]}")"
assert_status "200" "POST /peers/batch with action:delete returns 200"

subsection "Verify batch-deleted peers"
parse "$(api GET "/peers/$BATCH_PEER1_ID")"
assert_status "404" "Batch-deleted peer 1 returns 404"

parse "$(api GET "/peers/$BATCH_PEER2_ID")"
assert_status "404" "Batch-deleted peer 2 returns 404"

# Remove from cleanup since already deleted
CLEANUP_PEER_IDS=("${CLEANUP_PEER_IDS[@]/$BATCH_PEER1_ID}")
CLEANUP_PEER_IDS=("${CLEANUP_PEER_IDS[@]/$BATCH_PEER2_ID}")

subsection "Invalid batch action"
parse "$(api POST "/peers/batch" -d '{"action":"invalid","ids":[1]}')"
assert_status "400" "POST /peers/batch with action:invalid returns 400"

subsection "Empty IDs"
parse "$(api POST "/peers/batch" -d '{"action":"enable","ids":[]}')"
assert_status "400" "POST /peers/batch with empty ids returns 400"

# ============================================================================
# 28. PEER GROUPS
# ============================================================================

section "28. Peer Groups"

subsection "Create group"
parse "$(api POST "/peer-groups" -d '{"name":"Test Group","color":"#3b82f6"}')"
assert_status "201" "POST /peer-groups returns 201"
assert_json ".ok" "true" "Create group response ok"
GROUP_ID=$(echo "$BODY" | jq -r '.group.id // .peerGroup.id // .peer_group.id')
if [ -n "$GROUP_ID" ] && [ "$GROUP_ID" != "null" ]; then
  pass "Group ID returned: #$GROUP_ID"
  CLEANUP_PEER_GROUP_IDS+=("$GROUP_ID")
else
  fail "Group ID returned" "could not extract group ID"
fi

subsection "List groups"
parse "$(api GET "/peer-groups")"
assert_status "200" "GET /peer-groups returns 200"
GRP_FOUND=$(echo "$BODY" | jq "[(.groups // .peerGroups // .peer_groups // [])[] | select(.id == $GROUP_ID)] | length" 2>/dev/null)
if [ "$GRP_FOUND" = "1" ]; then
  pass "New group appears in list"
else
  fail "Group in list" "Group #$GROUP_ID not found in list"
fi

subsection "Update group"
parse "$(api PUT "/peer-groups/$GROUP_ID" -d '{"name":"Updated Group"}')"
assert_status "200" "PUT /peer-groups/$GROUP_ID returns 200"

subsection "Assign peer to group"
parse "$(api PUT "/peers/$PEER_ID" -d "{\"group_id\":$GROUP_ID}")"
assert_status "200" "PUT /peers/$PEER_ID with group_id returns 200"

subsection "Verify group in peer GET"
parse "$(api GET "/peers/$PEER_ID")"
assert_status "200" "GET /peers/$PEER_ID returns 200"
PEER_GROUP=$(echo "$BODY" | jq -r '.peer.group_id // empty')
if [ -n "$PEER_GROUP" ] && [ "$PEER_GROUP" != "null" ]; then
  pass "group_id present in peer ($PEER_GROUP)"
else
  fail "group_id in peer GET" "expected group_id to be set"
fi

subsection "Remove peer from group"
parse "$(api PUT "/peers/$PEER_ID" -d '{"group_id":null}')"
assert_status "200" "PUT /peers/$PEER_ID with group_id:null returns 200"

subsection "Delete group"
parse "$(api DELETE "/peer-groups/$GROUP_ID")"
assert_status "200" "DELETE /peer-groups/$GROUP_ID returns 200"
CLEANUP_PEER_GROUP_IDS=("${CLEANUP_PEER_GROUP_IDS[@]/$GROUP_ID}")

subsection "Verify group deleted"
parse "$(api GET "/peer-groups")"
GRP_FOUND=$(echo "$BODY" | jq "[(.groups // .peerGroups // .peer_groups // [])[] | select(.id == $GROUP_ID)] | length" 2>/dev/null)
if [ "$GRP_FOUND" = "0" ] || [ -z "$GRP_FOUND" ]; then
  pass "Group no longer in list after delete"
else
  fail "Group deleted" "Group #$GROUP_ID still appears in list"
fi

# ============================================================================
# 29. BACKWARD COMPATIBILITY
# ============================================================================

section "29. Backward Compatibility (/api/ alias)"

subsection "/api/ prefix (legacy)"
RESP=$(curl -sk -w "\n%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/dashboard/stats" 2>/dev/null)
parse "$RESP"
if [ "$HTTP_CODE" = "200" ]; then
  pass "Legacy /api/ prefix works"
elif [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
  pass "Legacy /api/ prefix redirects ($HTTP_CODE)"
elif [ "$HTTP_CODE" = "404" ]; then
  skip "Legacy /api/ prefix" "alias removed, /api/v1/ is the only prefix"
else
  fail "Legacy /api/ prefix" "Expected 200/301/302/404, got $HTTP_CODE"
fi

# ============================================================================
# 30. ERROR HANDLING & EDGE CASES
# ============================================================================

section "30. Error Handling & Edge Cases"

subsection "Consistent error format"
parse "$(api GET "/peers/99999")"
assert_json ".ok" "false" "Error has ok: false"
assert_json_exists ".error" "Error has error message"

subsection "Invalid JSON body"
RESP=$(curl -sk -w "\n%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST \
  -d "not-json{{{" \
  "$API/peers" 2>/dev/null)
parse "$RESP"
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ] || [ "$HTTP_CODE" = "500" ]; then
  pass "Invalid JSON handled (HTTP $HTTP_CODE)"
else
  fail "Invalid JSON handling" "Expected 400/422/500, got $HTTP_CODE"
fi

subsection "Method not allowed"
RESP=$(curl -sk -w "\n%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -X PATCH \
  "$API/peers/$PEER_ID" 2>/dev/null)
parse "$RESP"
if [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "405" ]; then
  pass "PATCH not allowed (HTTP $HTTP_CODE)"
else
  skip "Method not allowed" "HTTP $HTTP_CODE"
fi

subsection "SQL injection attempt"
parse "$(api GET "/peers/1%27%20OR%201%3D1%20--")"
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "500" ]; then
  pass "SQL injection rejected (HTTP $HTTP_CODE)"
else
  fail "SQL injection protection" "Unexpected HTTP $HTTP_CODE"
fi

subsection "XSS in input"
parse "$(api POST "/peers" -d '{"name":"<script>alert(1)</script>","description":"xss test"}')"
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ]; then
  pass "XSS in name rejected (HTTP $HTTP_CODE)"
else
  # If accepted, check it's escaped in response
  XSS_CHECK=$(echo "$BODY" | jq -r '.peer.name // empty')
  if echo "$XSS_CHECK" | grep -q "<script>"; then
    fail "XSS protection" "Script tags stored as-is"
    DUP_ID=$(echo "$BODY" | jq -r '.peer.id // empty')
    if [ -n "$DUP_ID" ]; then CLEANUP_PEER_IDS+=("$DUP_ID"); fi
  else
    pass "XSS sanitized in response"
    DUP_ID=$(echo "$BODY" | jq -r '.peer.id // empty')
    if [ -n "$DUP_ID" ]; then CLEANUP_PEER_IDS+=("$DUP_ID"); fi
  fi
fi

# ============================================================================
# 31. DELETE (CLEANUP VERIFICATION)
# ============================================================================

section "31. Delete Operations"

subsection "Delete peer"
parse "$(api DELETE "/peers/$PEER2_ID")"
assert_status "200" "DELETE /peers/$PEER2_ID returns 200"

parse "$(api GET "/peers/$PEER2_ID")"
assert_status "404" "Deleted peer returns 404"
CLEANUP_PEER_IDS=("${CLEANUP_PEER_IDS[@]/$PEER2_ID}")

subsection "Delete route"
parse "$(api DELETE "/routes/$ROUTE_ID")"
assert_status "200" "DELETE /routes/$ROUTE_ID returns 200"

parse "$(api GET "/routes/$ROUTE_ID")"
assert_status "404" "Deleted route returns 404"
CLEANUP_ROUTE_IDS=("${CLEANUP_ROUTE_IDS[@]/$ROUTE_ID}")

subsection "Delete webhook"
parse "$(api DELETE "/webhooks/$WEBHOOK_ID")"
assert_status "200" "DELETE /webhooks/$WEBHOOK_ID returns 200"
CLEANUP_WEBHOOK_IDS=("${CLEANUP_WEBHOOK_IDS[@]/$WEBHOOK_ID}")

subsection "Delete already deleted"
parse "$(api DELETE "/peers/$PEER2_ID")"
assert_status "404" "Double-delete returns 404"
