# Deploying to Azure

Same pattern as the ESG app: Bicep provisions the platform once, then every push to `main` is tested, scanned, built into images on GHCR and rolled out by GitHub Actions. Actions logs in to Azure through OIDC, so no Azure secret is stored. A smoke test runs against the live URL after each rollout, with automatic rollback if it fails.

```
GitHub push ──► test (Jest on PostgreSQL) ─┐
             └► security (npm audit, gitleaks, Trivy, Bicep) ─┴► build + scan images ─► push to GHCR
                                                                                  │
                         Azure (OIDC login) ◄─────────────────────────────────────┘
                         ├─ Keycloak container app  (tos-keycloak image, realms baked in)
                         ├─ TOS API container app    (tos image, migrations on start)
                         ├─ PostgreSQL Flexible      (databases tos + keycloak)
                         └─ health wait ─► smoke test (scripts/smoke.mjs) ─► rollback on failure
```

## One-time setup (Azure Cloud Shell, bash)

1. **Images exist first.** Push to `main` once; the workflow publishes `ghcr.io/indranil32/tos` and `ghcr.io/indranil32/tos-keycloak` (the deploy job is skipped until step 4). If Azure cannot pull them, make both packages public under GitHub → Packages, or pass `registryUser`/`registryPassword`.

2. **Provision** (trial: reuse the existing Container Apps environment, e.g. the ESG one):

   ```bash
   git clone https://github.com/indranil32/tos && cd tos
   az group create -n rg-tos-dev -l centralindia
   export TOS_ENVIRONMENT_ID=$(az containerapp env list --query "[0].id" -o tsv)   # blank = create a new one
   export TOS_DB_PASSWORD=$(openssl rand -base64 24) TOS_APP_DB_PASSWORD=$(openssl rand -hex 24) \
          TOS_KC_ADMIN_PASSWORD=$(openssl rand -base64 18) TOS_DEMO_PASSWORD=$(openssl rand -hex 12) \
          TOS_EDI_PARTNER_SECRET=$(openssl rand -hex 24)
   az deployment group create -g rg-tos-dev -f infra/main.bicep -p infra/dev.bicepparam \
      --query properties.outputs -o json
   ```

   Keep the passwords somewhere safe; they are also stored as container-app secrets (`az containerapp secret show`).

3. **GitHub OIDC trust**:

   ```bash
   infra/github-oidc-setup.sh rg-tos-dev indranil32/tos azure-dev "$TOS_ENVIRONMENT_ID"
   ```

4. **GitHub settings** → Environments → `azure-dev` → variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` (printed by step 3).

5. **Deploy**: Actions → CI/CD → Run workflow (or push to `main`). The first smoke run also provisions the `demo` tenant, terminal `MPT1`, yard, line `MSC` and tariffs.

### Trial subscription: sharing the ESG PostgreSQL server

The personal trial refuses a second PostgreSQL B1ms server (tried UK South and Central India). For dev, the TOS can share the ESG server with its **own login and databases**:

```bash
TOS_SHARE_PG_FROM=rg-esg-dev-in/ca-esgdev-s3ns6dgxqvym6 infra/bootstrap-dev.sh
```

The ESG admin URL is read once in Cloud Shell to create `tosadmin` (CREATEROLE, not superuser) and the `tos` and `keycloak` databases, both owned by `tosadmin` with `CONNECT` revoked from `PUBLIC`. The TOS deployment only receives the `tosadmin` password, and the TOS runtime role `tos_app` can connect only to `tos`. For the company subscription, give the TOS its own server.

## After deployment

| What | Where |
|---|---|
| API | `apiUrl` output, e.g. `https://ca-tosdev-xxxx.<env>.azurecontainerapps.io/health` |
| Identity broker | `keycloakUrl` output; admin console user `admin`, password `TOS_KC_ADMIN_PASSWORD` |
| Demo users | platform realm `operator`; demo realm `admin`, `gate`; password `TOS_DEMO_PASSWORD` (client `tos-cli`) |
| Partner client | demo realm `tos-edi-partner`, client credentials, secret `TOS_EDI_PARTNER_SECRET` |

Get a token and call the API:

```bash
KC=https://<keycloakUrl>; API=https://<apiUrl>
TOKEN=$(curl -s -d grant_type=password -d client_id=tos-cli -d username=admin -d "password=$TOS_DEMO_PASSWORD" \
  $KC/realms/demo/protocol/openid-connect/token | jq -r .access_token)
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Facility: MPT1" $API/v1/units
```

## Company subscription

Use `infra/prod.bicepparam` (General Purpose PostgreSQL, UAE North, Entra ID issuers trusted) and review with IT security: put PostgreSQL on a private endpoint, front the apps with Front Door/WAF, move Keycloak to `KC_HOSTNAME` on a company domain, and federate the AD Ports Entra tenant into each tenant realm (SAML or OIDC).

## Not verified from here

The template compiles and lints cleanly with Bicep 0.49 and the smoke test passes against a local stack with real OIDC discovery. Nothing has been deployed to Azure from this environment yet, so expect small fixes on the first real run (most likely: GHCR package visibility, Keycloak start-up time).
