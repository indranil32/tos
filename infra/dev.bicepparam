using './main.bicep'

// Trial / personal subscription. Synthetic data only.
param prefix = 'tosdev'
param location = 'centralindia'   // must match the reused environment's region
// PostgreSQL region: trial subscriptions refuse some regions/SKUs (UK South was refused for a 2nd B1ms server).
param dbLocation = readEnvironmentVariable('TOS_DB_LOCATION', 'centralindia')
// Trial subscriptions allow one Container Apps environment: reuse the ESG one, e.g.
//   az containerapp env list --query "[0].id" -o tsv
param existingEnvironmentId = readEnvironmentVariable('TOS_ENVIRONMENT_ID', '')
param maxReplicas = 1
// Shared PostgreSQL (set by infra/bootstrap-dev.sh when TOS_SHARE_PG_FROM is given): separate login and databases.
param externalPgHost = readEnvironmentVariable('TOS_EXTERNAL_PG_HOST', '')
// Secrets come from the shell, never from this file:
//   export TOS_DB_PASSWORD=$(openssl rand -base64 24) TOS_APP_DB_PASSWORD=$(openssl rand -hex 24) \
//          TOS_KC_ADMIN_PASSWORD=$(openssl rand -base64 18) TOS_DEMO_PASSWORD=$(openssl rand -base64 18) \
//          TOS_EDI_PARTNER_SECRET=$(openssl rand -hex 24)
param dbAdminPassword = readEnvironmentVariable('TOS_DB_PASSWORD', '')
param appDbPassword = readEnvironmentVariable('TOS_APP_DB_PASSWORD', '')
param keycloakAdminPassword = readEnvironmentVariable('TOS_KC_ADMIN_PASSWORD', '')
param demoPassword = readEnvironmentVariable('TOS_DEMO_PASSWORD', '')
param ediPartnerSecret = readEnvironmentVariable('TOS_EDI_PARTNER_SECRET', '')
