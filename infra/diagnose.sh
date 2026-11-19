#!/usr/bin/env bash
# Health of the TOS apps in a resource group: revisions, endpoints and recent logs.
# Usage: infra/diagnose.sh [resource-group=rg-tos-dev] [log-lines=25]
RG=${1:-rg-tos-dev}; N=${2:-25}
for role in keycloak api; do
  APP=$(az containerapp list -g "$RG" --query "[?tags.\"tos-role\"=='$role'].name | [0]" -o tsv)
  FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
  echo "=== $role: $APP"
  az containerapp revision list -g "$RG" -n "$APP" --query "[?properties.active].{rev:name,img:properties.template.containers[0].image,health:properties.healthState,state:properties.runningState}" -o tsv
  if [ "$role" = keycloak ]; then URL="https://$FQDN/realms/platform/.well-known/openid-configuration"; else URL="https://$FQDN/health"; fi
  echo "endpoint: $(curl -s -m 10 -o /dev/null -w '%{http_code}' "$URL")"
  az containerapp logs show -g "$RG" -n "$APP" --tail "$N" --format text 2>&1 | cut -c1-180 | tail -n "$N"
done
