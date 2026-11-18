# TOS platform

A Terminal Operating System for small and medium **multipurpose** terminals: containers, break-bulk/general cargo, RoRo and liquid bulk. One codebase runs as **multi-tenant SaaS** or **on-prem**, with billing built in, an API for every standard EDI message, and federated identity (OIDC, OAuth 2.0, SAML via the broker, SSO).

> Status: v0.1, the platform skeleton plus the first vertical slice. One vessel call is handled end to end, from discharge list to invoice, with customs holds at the gate and COPRAR/COARRI/CODECO.

## What works today

- **Tenancy:** tenant → complex → facility → yard → block, with PostgreSQL row-level security on every tenant table.
- **Identity:** OIDC bearer tokens verified through discovery/JWKS, one IdP realm per tenant, roles, and per-facility scope.
- **Vessel:** vessels, visits (planned → arrived → working → departed), load/discharge lists and discharge confirmation.
- **Inventory:** units for all four cargo kinds, ISO 6346 and ISO 3779 validation, rule-based yard allocation, and holds.
- **Gate:** gate in/out, blocked by active holds, with rejected visits recorded.
- **Billing:** tariffs (contract rate over standard, facility over tenant-wide), charges accrued in the same transaction as the move, and invoices per customer and currency.
- **EDI:** EDIFACT parser/writer, COPRAR in, COARRI and CODECO out, and a message log with APERAK-style rejects.
- **Events:** a transactional outbox with an event feed at `GET /v1/events`.

## Run it

```bash
docker compose up --build        # PostgreSQL, Keycloak (realms: platform, demo), API on :3000
./scripts/seed-demo.sh           # demo tenant, terminal MPT1, yard, line MSC, tariffs
```

Demo logins (Keycloak, client `tos-cli`): platform realm `operator/operator`; demo realm `admin/admin`, `gate/gate`.

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

1. Export flow: gate-in, load list, load confirmation, COARRI load report, VGM block (SOLAS).
2. Customs adapter: WCO Data Model mapping, ASYCUDA World connector, CUSCAR/CUSRES.
3. Event dispatcher: webhooks, EDI auto-send per partner profile, Oracle ERP invoice export.
4. Cargo workflows: break-bulk tally, RoRo lanes and damage checks, liquid nominations and meter tickets.
5. Equipment control: CHE work queues and the handheld app; yard optimiser behind `YardAllocator`.
6. Web UI (React) on the same API.
