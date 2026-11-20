# TOS platform

A Terminal Operating System for small and medium **multipurpose** terminals: containers, break-bulk/general cargo, RoRo and liquid bulk. One codebase runs as **multi-tenant SaaS** or **on-prem**, with billing built in, an API for every standard EDI message, and federated identity (OIDC, OAuth 2.0, SAML via the broker, SSO).

> Status: v0.6, Phase 1 yard strategy: planner ranges, block rules for sizes, reefers, DG and stack weight, stacking by export group, and restows as crane moves. Known limitations and pending items: [tracker](https://claude.ai/artifact/PsgCgCkRfKGMbyaPAWaTdY). v0.5, Phase 1 vessel planning: berth plan, BAPLIE in/out with restow detection, load stow planning and crane split into sequenced crane queues. v0.4, Phase 0 foundations: terminal model, equipment, work queues with dispatch, and live updates. v0.3: web screens. v0.2: A full vessel call runs end to end: discharge to invoice, plus export gate-in, SOLAS VGM, load and departure. Transshipment works, and it deploys to Azure through GitHub Actions.

## What works today

- **Tenancy:** tenant → complex → facility → yard → block, with PostgreSQL row-level security on every tenant table.
- **Identity:** OIDC bearer tokens verified through discovery/JWKS, one IdP realm per tenant, roles, and per-facility scope.
- **Vessel:** vessels, visits (planned → arrived → working → departed), load/discharge lists, discharge and load confirmation (stow cell) and departure close-out.
- **SOLAS VGM:** set by API, at gate-in or by VERMAS; packed containers without VGM can't be loaded.
- **Inventory:** units for all four cargo kinds, ISO 6346 and ISO 3779 validation, rule-based yard allocation, and holds.
- **Gate:** gate in/out, blocked by active holds, with rejected visits recorded.
- **Billing:** tariffs (contract rate over standard, facility over tenant-wide), charges accrued in the same transaction as the move, and invoices per customer and currency.
- **EDI:** EDIFACT parser/writer, COPRAR and VERMAS in, COARRI (discharge and load) and CODECO out, and a message log with APERAK-style rejects.
- **Events:** a transactional outbox with an event feed at `GET /v1/events` and a live stream at `GET /v1/stream` (Server-Sent Events, tenant and facility scoped, replay with `Last-Event-ID`).
- **Terminal model:** facility kinds (seaport, dry port, container depot, CFS) and corridors between facilities; berths on quay metres; yard areas (container stacks with sizes, stack weight, reefer plugs and DG classes, laydown, RoRo lanes, tanks, warehouses); rail tracks and gate lanes. `GET /v1/terminal` returns the whole layout.
- **Equipment:** machines of every kind (QC, MHC, RTG, RMG, reach stacker, straddle, truck, forklift ...), pools, status log, shifts and gangs. A breakdown hands the machine's jobs back to their queues.
- **Vessel planning:** vessel particulars and bay profile; a berth plan on quay metres with clash, length and draft checks; arrival BAPLIE (SMDG 2.x) builds the discharge list for this port, flags restows (cargo above this port's units and deck cargo over hold discharges) and keeps the rest as remain-on-board; load units are stowed cell by cell with 20'/40' bay and occupancy checks; the crane split gives each crane a contiguous bay range, balanced by workload, and builds its work queue in hatch order (discharge deck then hold, load hold then deck); the departure BAPLIE lists what stays on board plus what was loaded.
- **Yard strategy:** planners reserve bays for a group of cargo (exports for a vessel and POD, a line's empties, a weight class, reefers); matching units fill their ranges first and other units never use them. Every slot follows the block rules: allowed sizes and one size per stack, no floating or buried units, reefers on free plugs, DG units only where their IMDG class is allowed, and the stack weight limit. Exports stack by vessel, POD, size and weight class with heavy below light. `POST /v1/yard/allocate-preview` says where a unit would go and why.
- **Work queues and dispatch:** moves are planned into queues per point of work (crane, block, rail track, housekeeping) and dispatched to a dedicated machine or a pool, most urgent queue first. Machines ask for the next job, start, complete or hand it back; vessel moves complete through the vessel module so COARRI, billing and VGM rules still apply. Optimistic versions stop stale confirmations.

## Web app

React screens served by the API at `/`: dashboard, berth plan, bay plan with click-to-stow, crane split, terminal layout, equipment, work queues with a machine console, vessel visits (arrive, discharge, load, depart, load-list CSV, COARRI download), units (holds, VGM), yard view (colour by category, line, dwell or special cargo), gate, invoices and uninvoiced charges, EDI messages (upload, raw view) and the event feed.

Every list uses one data grid with:
- **Simple filters:** quick search and one-click status/category chips with counts.
- **Advanced filters:** conditions combined with AND/OR, one level of nested groups, and operators per type (text, number, date incl. last/next N days, list, yes/no).
- **Sorting:** click a header to sort; Shift+click or the sort builder adds levels; statuses sort in life-cycle order.
- **Configurable columns:** show/hide and reorder, saved per user in the browser; CSV export of the filtered view.

Colours come from one source, `web/src/theme/colors.ts`, which drives every badge, chip, flag, row accent, the yard and the in-app colour guide. See [docs/color-coding.md](docs/color-coding.md), which is generated from it.

Local development without Keycloak:

```bash
node scripts/dev-idp.mjs &                       # dev-only OIDC provider on :8099 (password "pw")
PLATFORM_OIDC_ISSUER=http://127.0.0.1:8099/realms/platform TRUSTED_ISSUER_PREFIXES=http://127.0.0.1:8099/realms/ \
  OWNER_DATABASE_URL=... APP_DATABASE_URL=... npm start   # API on :3000
(cd web && npm run dev)                          # UI on :5173, proxies /v1 to the API
BASE_URL=http://127.0.0.1:3000 KC_URL=http://127.0.0.1:8099 DEMO_PASSWORD=pw node scripts/smoke.mjs && node scripts/demo-data.mjs
```

## Run it

```bash
docker compose up --build        # PostgreSQL, Keycloak (realms: platform, demo), API on :3000
./scripts/seed-demo.sh           # demo tenant, terminal MPT1, yard, line MSC, tariffs
```

Demo logins (Keycloak, client `tos-cli`), password `demo_dev_only` locally: platform realm `operator`; demo realm `admin`, `gate`.

## Deploy to Azure

The same pattern as the ESG app: Bicep, Container Apps, PostgreSQL Flexible, GHCR images, OIDC login from GitHub Actions, then a smoke test with rollback. Every push to `main` deploys to the dev environment (`rg-tos-dev`). See [docs/azure-deploy.md](docs/azure-deploy.md).

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
