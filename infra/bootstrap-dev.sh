#!/usr/bin/env bash
# One-shot dev setup in Azure Cloud Shell: provision, wire GitHub OIDC, print what GitHub needs.
# Usage (Cloud Shell, from the repo root): infra/bootstrap-dev.sh [resource-group=rg-tos-dev]
# Reuses the first Container Apps environment in Central India (trial subscriptions allow one).
set -euo pipefail
RG=${1:-rg-tos-dev}
LOC=centralindia
OUT=${OUT:-$HOME/tos-bootstrap.txt}

say() { echo "[tos] $*"; }

for ns in Microsoft.App Microsoft.DBforPostgreSQL Microsoft.OperationalInsights; do
  az provider register -n "$ns" -o none
done

TOS_ENVIRONMENT_ID=${TOS_ENVIRONMENT_ID:-$(az containerapp env list --query "[?location=='Central India'] | [0].id" -o tsv)}
export TOS_ENVIRONMENT_ID
say "Container Apps environment: ${TOS_ENVIRONMENT_ID:-<new>}"

az group create -n "$RG" -l "$LOC" -o none
say "Resource group $RG ready"

# Secrets: generated once per run, stored only as container-app secrets in Azure.
export TOS_DB_PASSWORD=${TOS_DB_PASSWORD:-"Tos$(openssl rand -hex 16)!"}
export TOS_APP_DB_PASSWORD=${TOS_APP_DB_PASSWORD:-$(openssl rand -hex 24)}
export TOS_KC_ADMIN_PASSWORD=${TOS_KC_ADMIN_PASSWORD:-$(openssl rand -hex 16)}
export TOS_DEMO_PASSWORD=${TOS_DEMO_PASSWORD:-$(openssl rand -hex 12)}
export TOS_EDI_PARTNER_SECRET=${TOS_EDI_PARTNER_SECRET:-$(openssl rand -hex 24)}

say "Deploying infra/main.bicep (PostgreSQL takes 5-10 minutes)..."
az deployment group create -g "$RG" -n tos-dev -f infra/main.bicep -p infra/dev.bicepparam \
  --query properties.outputs -o json > "$HOME/tos-outputs.json"
say "Deployment done"

say "Setting up GitHub OIDC trust..."
infra/github-oidc-setup.sh "$RG" indranil32/tos azure-dev "$TOS_ENVIRONMENT_ID" > "$HOME/tos-oidc.txt"

{
  echo "== GitHub environment azure-dev variables =="
  grep -E '^AZURE_' "$HOME/tos-oidc.txt"
  echo "== URLs =="
  python3 -c "import json;o=json.load(open('$HOME/tos-outputs.json'));[print(k+'='+v['value']) for k,v in o.items()]"
} | tee "$OUT"
say "Summary saved to $OUT (no passwords). Passwords live in the container-app secrets."
