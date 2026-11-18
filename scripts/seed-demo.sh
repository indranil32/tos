#!/usr/bin/env bash
# Provision the "demo" tenant and a small multipurpose terminal through the public API.
# Run after `docker compose up`. Requires curl and jq.
set -euo pipefail
API="${API:-http://localhost:3000}"
KC="${KC:-http://localhost:8080}"

tok() { # realm user password
  curl -fsS -d grant_type=password -d client_id=tos-cli -d "username=$2" -d "password=$3" \
    "$KC/realms/$1/protocol/openid-connect/token" | jq -r .access_token
}
post() { # token path json [facility]
  curl -fsS -X POST "$API$2" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
    ${4:+-H "X-Facility: $4"} -d "$3"; echo
}

PLATFORM=$(tok platform operator operator)
post "$PLATFORM" /v1/platform/tenants "{\"code\":\"demo\",\"name\":\"Demo Port Co\",\"oidcIssuer\":\"$KC/realms/demo\"}"

ADMIN=$(tok demo admin admin)
post "$ADMIN" /v1/complexes '{"code":"KHL","name":"Demo Port Complex"}'
post "$ADMIN" /v1/facilities '{"complexCode":"KHL","code":"MPT1","name":"Multipurpose Terminal 1","unlocode":"AEKHL","currency":"AED","timezone":"Asia/Dubai"}'
post "$ADMIN" /v1/yards '{"facilityCode":"MPT1","code":"Y1","name":"Main yard"}'
post "$ADMIN" /v1/yard-blocks '{"facilityCode":"MPT1","yardCode":"Y1","code":"A1","blockType":"CONTAINER_STACK","bays":20,"rows":6,"tiers":4}'
post "$ADMIN" /v1/yard-blocks '{"facilityCode":"MPT1","yardCode":"Y1","code":"L1","blockType":"LAYDOWN","capacity":200}'
post "$ADMIN" /v1/yard-blocks '{"facilityCode":"MPT1","yardCode":"Y1","code":"R1","blockType":"RORO_LANE","capacity":500}'
post "$ADMIN" /v1/partners '{"code":"MSC","name":"Mediterranean Shipping Co","roles":["LINE_OPERATOR","CUSTOMER"]}'
post "$ADMIN" /v1/tariffs '{"chargeCode":"DISCH","description":"Container discharge","cargoKind":"CONTAINER","triggerEvent":"unit.discharged","basis":"PER_TEU","rate":50,"currency":"AED"}' MPT1
post "$ADMIN" /v1/tariffs '{"chargeCode":"STOR","description":"Import storage","cargoKind":"CONTAINER","triggerEvent":"storage","basis":"PER_DAY","rate":10,"currency":"AED","freeDays":3}' MPT1
echo "Demo tenant ready. Admin token: tok demo admin admin"
