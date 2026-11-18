using './main.bicep'

// Trial / personal subscription. Synthetic data only.
param prefix = 'tosdev'
param location = 'centralindia'   // must match the reused environment's region
param dbLocation = 'uksouth'       // PostgreSQL is restricted in some trial regions
// Trial subscriptions allow one Container Apps environment: reuse the ESG one, e.g.
//   az containerapp env list --query "[0].id" -o tsv
param existingEnvironmentId = readEnvironmentVariable('TOS_ENVIRONMENT_ID', '')
param maxReplicas = 1
// Secrets come from the shell, never from this file:
//   export TOS_DB_PASSWORD=$(openssl rand -base64 24) TOS_APP_DB_PASSWORD=$(openssl rand -hex 24) \
//          TOS_KC_ADMIN_PASSWORD=$(openssl rand -base64 18) TOS_DEMO_PASSWORD=$(openssl rand -base64 18) \
//          TOS_EDI_PARTNER_SECRET=$(openssl rand -hex 24)
param dbAdminPassword = readEnvironmentVariable('TOS_DB_PASSWORD', '')
param appDbPassword = readEnvironmentVariable('TOS_APP_DB_PASSWORD', '')
param keycloakAdminPassword = readEnvironmentVariable('TOS_KC_ADMIN_PASSWORD', '')
param demoPassword = readEnvironmentVariable('TOS_DEMO_PASSWORD', '')
param ediPartnerSecret = readEnvironmentVariable('TOS_EDI_PARTNER_SECRET', '')
