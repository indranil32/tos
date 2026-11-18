// TOS platform - Azure deployment (same template for a trial subscription and the company subscription).
//   az group create -n rg-tos-dev -l centralindia
//   az deployment group create -g rg-tos-dev -f infra/main.bicep -p infra/dev.bicepparam
// Resources: Log Analytics, PostgreSQL Flexible Server (databases tos + keycloak),
// Container Apps environment (new, or an existing one), TOS API app, Keycloak identity-broker app.
targetScope = 'resourceGroup'

@minLength(3)
@maxLength(12)
@description('Short name used to build resource names (letters/numbers).')
param prefix string = 'tos'

@description('Region of the container apps (must match the environment region when reusing one).')
param location string = resourceGroup().location

@description('Region for PostgreSQL. Trial subscriptions cannot create it in every region.')
param dbLocation string = location

@description('Resource id of an existing Container Apps environment to reuse (trial subscriptions allow one). Blank creates a new one.')
param existingEnvironmentId string = ''

@description('TOS API image.')
param image string = 'ghcr.io/indranil32/tos:latest'

@description('Keycloak (identity broker) image with the realms baked in.')
param keycloakImage string = 'ghcr.io/indranil32/tos-keycloak:latest'

@secure()
@description('PostgreSQL administrator password (also owns the TOS schema and runs migrations).')
param dbAdminPassword string

@secure()
@description('Password of the tos_app role the API uses at runtime (row-level security applies to it).')
param appDbPassword string

@secure()
@description('Keycloak bootstrap admin password (admin console).')
param keycloakAdminPassword string

@secure()
@description('Password of the seeded demo users (platform operator, demo admin, demo gate). Synthetic data only.')
param demoPassword string

@secure()
@description('Client secret of the example EDI/API partner client (OAuth client credentials).')
param ediPartnerSecret string

@description('Extra trusted issuer prefixes, comma separated (e.g. https://login.microsoftonline.com/ for Entra ID tenants).')
param extraTrustedIssuers string = ''

@description('Optional GHCR credentials when the images are private.')
param registryUser string = ''
@secure()
param registryPassword string = ''

param dbSku string = 'Standard_B1ms'
param dbTier string = 'Burstable'
param maxReplicas int = 2

var uniq = uniqueString(resourceGroup().id)
var appName = 'ca-${prefix}-${uniq}'
var kcName = 'kc-${prefix}-${uniq}'
var reuseEnv = existingEnvironmentId != ''

// ---------------------------------------------------------------- monitoring
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (!reuseEnv) {
  name: 'log-${prefix}-${uniq}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 90 }
}

// ---------------------------------------------------------------- database
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-${prefix}-${uniq}'
  location: dbLocation
  sku: { name: dbSku, tier: dbTier }
  properties: {
    version: '16'
    administratorLogin: 'tosadmin'
    administratorLoginPassword: dbAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}
resource tosDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'tos'
}
resource kcDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'keycloak'
  dependsOn: [tosDb]
}
// Lets Azure-hosted services connect. Use VNet integration / private endpoint for production.
resource pgAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// ---------------------------------------------------------------- container apps environment
resource newEnv 'Microsoft.App/managedEnvironments@2024-03-01' = if (!reuseEnv) {
  name: 'cae-${prefix}-${uniq}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs!.properties.customerId
        sharedKey: logs!.listKeys().primarySharedKey
      }
    }
  }
}
resource oldEnv 'Microsoft.App/managedEnvironments@2024-03-01' existing = if (reuseEnv) {
  name: last(split(existingEnvironmentId, '/'))
  scope: resourceGroup(split(existingEnvironmentId, '/')[2], split(existingEnvironmentId, '/')[4])
}
var envId = reuseEnv ? existingEnvironmentId : newEnv.id
var envDomain = reuseEnv ? oldEnv!.properties.defaultDomain : newEnv!.properties.defaultDomain
var kcUrl = 'https://${kcName}.${envDomain}'

var pgHost = pg.properties.fullyQualifiedDomainName
var registries = registryUser == '' ? [] : [
  { server: 'ghcr.io', username: registryUser, passwordSecretRef: 'registry-password' }
]
var registrySecrets = registryUser == '' ? [] : [
  { name: 'registry-password', value: registryPassword }
]

// ---------------------------------------------------------------- identity broker (Keycloak)
resource kc 'Microsoft.App/containerApps@2024-03-01' = {
  name: kcName
  location: location
  tags: { 'tos-role': 'keycloak' }
  properties: {
    managedEnvironmentId: envId
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto' }
      registries: registries
      secrets: concat([
        { name: 'db-password', value: dbAdminPassword }
        { name: 'admin-password', value: keycloakAdminPassword }
        { name: 'demo-password', value: demoPassword }
        { name: 'edi-partner-secret', value: ediPartnerSecret }
      ], registrySecrets)
    }
    template: {
      containers: [
        {
          name: 'keycloak'
          image: keycloakImage
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'KC_DB_URL', value: 'jdbc:postgresql://${pgHost}:5432/keycloak?sslmode=require' }
            { name: 'KC_DB_USERNAME', value: 'tosadmin' }
            { name: 'KC_DB_PASSWORD', secretRef: 'db-password' }
            { name: 'KC_HOSTNAME', value: kcUrl }
            { name: 'KC_HTTP_ENABLED', value: 'true' }
            { name: 'KC_PROXY_HEADERS', value: 'xforwarded' }
            { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' }
            { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', secretRef: 'admin-password' }
            { name: 'TOS_DEMO_PASSWORD', secretRef: 'demo-password' }
            { name: 'TOS_EDI_PARTNER_SECRET', secretRef: 'edi-partner-secret' }
          ]
          probes: [
            { type: 'Startup', tcpSocket: { port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 30 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [kcDb, pgAzure]
}

// ---------------------------------------------------------------- TOS API
var ownerUrl = 'postgres://tosadmin:${uriComponent(dbAdminPassword)}@${pgHost}:5432/tos?sslmode=require'
var appUrl = 'postgres://tos_app:${uriComponent(appDbPassword)}@${pgHost}:5432/tos?sslmode=require'
var trusted = extraTrustedIssuers == '' ? '${kcUrl}/realms/' : '${kcUrl}/realms/,${extraTrustedIssuers}'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: { 'tos-role': 'api' }
  properties: {
    managedEnvironmentId: envId
    configuration: {
      ingress: { external: true, targetPort: 3000, transport: 'auto' }
      registries: registries
      secrets: concat([
        { name: 'owner-database-url', value: ownerUrl }
        { name: 'app-database-url', value: appUrl }
        { name: 'app-db-password', value: appDbPassword }
      ], registrySecrets)
    }
    template: {
      containers: [
        {
          name: 'tos'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'OWNER_DATABASE_URL', secretRef: 'owner-database-url' }
            { name: 'APP_DATABASE_URL', secretRef: 'app-database-url' }
            { name: 'APP_DB_PASSWORD', secretRef: 'app-db-password' }
            { name: 'APP_DB_ROLE', value: 'tos_app' }
            { name: 'PLATFORM_OIDC_ISSUER', value: '${kcUrl}/realms/platform' }
            { name: 'TRUSTED_ISSUER_PREFIXES', value: trusted }
            { name: 'PORT', value: '3000' }
          ]
          probes: [
            { type: 'Readiness', httpGet: { path: '/health', port: 3000 }, initialDelaySeconds: 5 }
            { type: 'Liveness', httpGet: { path: '/health', port: 3000 }, initialDelaySeconds: 30, periodSeconds: 30 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: maxReplicas }
    }
  }
  dependsOn: [tosDb, pgAzure]
}

output apiUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output keycloakUrl string = kcUrl
output postgresServer string = pgHost
output apiAppName string = app.name
output keycloakAppName string = kc.name
