#!/usr/bin/env bash
# Creates an Entra app + federated credential so GitHub Actions can deploy without a stored secret.
# Usage: infra/github-oidc-setup.sh <resource-group> [github-repo=indranil32/tos] [environment=azure-dev] [container-apps-env-id]
# Pass the environment id when reusing an environment from another resource group (apps need join rights on it).
set -euo pipefail
RG=${1:?resource group}; REPO=${2:-indranil32/tos}; ENVN=${3:-azure-dev}; CAE=${4:-}
SUB=$(az account show --query id -o tsv); TENANT=$(az account show --query tenantId -o tsv)
APPID=$(az ad app list --display-name "tos-github-deploy" --query "[0].appId" -o tsv)
[ -n "$APPID" ] || APPID=$(az ad app create --display-name "tos-github-deploy" --query appId -o tsv)
az ad sp show --id "$APPID" >/dev/null 2>&1 || az ad sp create --id "$APPID" -o none
az ad app federated-credential create --id "$APPID" --parameters "{\"name\":\"github-$ENVN\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:$REPO:environment:$ENVN\",\"audiences\":[\"api://AzureADTokenExchange\"]}" -o none 2>/dev/null || echo "federated credential exists"
SCOPE=/subscriptions/$SUB/resourceGroups/$RG
az role assignment create --assignee "$APPID" --role Contributor --scope "$SCOPE" -o none 2>/dev/null || echo "role exists"
[ -z "$CAE" ] || az role assignment create --assignee "$APPID" --role Contributor --scope "$CAE" -o none 2>/dev/null || echo "env role exists"
echo "NOTE: if login fails with a subject mismatch, add a credential for the subject shown in the error (repos with ID-based subject claims)"
echo "Set these as GitHub environment variables (Settings > Environments > $ENVN):"
echo "AZURE_CLIENT_ID=$APPID"; echo "AZURE_TENANT_ID=$TENANT"; echo "AZURE_SUBSCRIPTION_ID=$SUB"; echo "AZURE_RESOURCE_GROUP=$RG"
