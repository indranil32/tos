# TOS platform

A Terminal Operating System for small and medium **multipurpose** terminals: containers, break-bulk/general cargo, RoRo and liquid bulk. One codebase runs as **multi-tenant SaaS** or **on-prem**, with billing built in, an API for every standard EDI message, and federated identity (OIDC, OAuth 2.0, SAML via the broker, SSO).

> Status: v0.2. A full vessel call runs end to end: discharge to invoice, plus export gate-in, SOLAS VGM, load and departure. Transshipment works, and it deploys to Azure through GitHub Actions.

## What works today

- **Tenancy:** tenant → complex → facility → yard → block, with PostgreSQL row-level security on every tenant table.
- **Identity:** OIDC bearer tokens verified through discovery/JWKS, one IdP realm per tenant, roles, and per-facility scope.
- **Vessel:** vessels, visits (planned → arrived → working → departed), load/discharge lists, discharge and load confirmation (stow cell) and departure close-out.
- **SOLAS VGM:** set by API, at gate-in or by VERMAS; packed containers without VGM can't be loaded.
- **Inventory:** units for all four cargo kinds, ISO 6346 and ISO 3779 validation, rule-based yard allocation, and holds.
- **Gate:** gate in/out, blocked by active holds, with rejected visits recorded.
- **Billing:** tariffs (contract rate over standard, facility over tenant-wide), charges accrued in the same transaction as the move, and invoices per customer and currency.
- **EDI:** EDIFACT parser/writer, COPRAR and VERMAS in, COARRI (discharge and load) and CODECO out, and a message log with APERAK-style rejects.
- **Events:** a transactional outbox with an event feed at `GET /v1/events`.

## Run it

```bash
docker compose up --build        # PostgreSQL, Keycloak (realms: platform, demo), API on :3000
./scripts/seed-demo.sh           # demo tenant, terminal MPT1, yard, line MSC, tariffs
```

Demo logins (Keycloak, client `tos-cli`), password `demo_dev_only` locally: platform realm `operator`; demo realm `admin`, `gate`.

## Deploy to Azure

The same pattern as the ESG app: Bicep, Container Apps, PostgreSQL Flexible, GHCR images, OIDC login from GitHub Actions, then a smoke test with rollback. See [docs/azure-deploy.md](docs/azure-deploy.md).

## Develop

```bash
npm ci
npm test          # starts a throwaway PostgreSQL (scripts/test-db.sh) if TEST_*_DATABASE_URL are not set
npm run build && OWNER_DATABASE_URL=... APP_DATABASE_URL=... npm start
```

| Variable | Purpose |
|---|---|
| `APP_DATABASE_URL` | App connection; must be a non-owner role so row-level security applies |
| `OWNER_DATABASE_URL` | Owner connection for migrations (run on start unless `MIGRATE_ON_START=false`) |
| `APP_DB_ROLE` | Role granted DML after migrations (default `tos_app`) |
| `PLATFORM_OIDC_ISSUER` | Issuer of the platform-operator realm |
| `TRUSTED_ISSUER_PREFIXES` | Comma-separated issuer prefixes accepted at all |
| `OIDC_AUDIENCE` | Expected `aud`, optional |
| `OIDC_URL_REWRITE` | `public=internal` URL rewrite for discovery/JWKS inside containers |

## Docs

- [Architecture](docs/architecture.md): stack decision, modules, tenancy, identity, deployment
- [Domain model](docs/domain-model.md): hierarchy, entities, cargo kinds, billing rules
- [EDI ↔ API catalogue](docs/edi-api-catalogue.md): every standard message, its endpoint, event and status
- [Customs and maritime standards](docs/standards-compliance.md): WCO Data Model / ASYCUDA adapter, ISO, IMO, IMDG, SOLAS, ISPS
- [OpenAPI](api/openapi.yaml) · [AsyncAPI events](api/asyncapi.yaml)

## Next slices

1. Customs adapter: WCO Data Model mapping, ASYCUDA World connector, CUSCAR/CUSRES.
2. Event dispatcher: webhooks, EDI auto-send per partner profile, Oracle ERP invoice export.
3. Cargo workflows: break-bulk tally, RoRo lanes and damage checks, liquid nominations and meter tickets.
4. Equipment control: CHE work queues and the handheld app; yard optimiser behind `YardAllocator`.
5. Web UI (React) on the same API.
