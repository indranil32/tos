using './main.bicep'

// Company subscription. Real data. Review every value with IT security before deploying.
param prefix = 'adptos'
param location = 'uaenorth'
param dbSku = 'Standard_D2ds_v5'
param dbTier = 'GeneralPurpose'
param maxReplicas = 4
param extraTrustedIssuers = 'https://login.microsoftonline.com/'  // Entra ID tenants used directly as OIDC issuers
param dbAdminPassword = readEnvironmentVariable('TOS_DB_PASSWORD', '')
param appDbPassword = readEnvironmentVariable('TOS_APP_DB_PASSWORD', '')
param keycloakAdminPassword = readEnvironmentVariable('TOS_KC_ADMIN_PASSWORD', '')
param demoPassword = readEnvironmentVariable('TOS_DEMO_PASSWORD', '')
param ediPartnerSecret = readEnvironmentVariable('TOS_EDI_PARTNER_SECRET', '')
