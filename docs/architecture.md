# Architecture

## Goals

A Terminal Operating System for **small and medium multipurpose terminals**: containers, break-bulk/general cargo, RoRo and liquid bulk. One codebase runs as **multi-tenant SaaS** or **on-prem** at a single port. Billing is built in. Every standard EDI message has a matching API. Identity is federated (OIDC, OAuth 2.0, SAML via the broker, SSO).

## Stack decision

| Choice | Why, for small and mid-sized ports |
|---|---|
| **Modular monolith** (one deployable) | One container to install, patch and back up on-prem; no service mesh to run. Module boundaries (own tables, events between modules) keep the option to split a module out for large SaaS tenants. |
| **TypeScript / NestJS on Node 22** | One language from API to web and handheld UIs; large hiring pool; structured modules and dependency injection. |
| **PostgreSQL 16** | Row-level security for tenant isolation; JSONB for events and partner payloads; runs everywhere (RDS/Azure/on-prem). |
| **Keycloak** (identity broker) | One realm per tenant; federates customer IdPs over SAML or OIDC; same product in SaaS and on-prem. Any OIDC provider works directly. |
| **Transactional outbox** | Events are written with the data change; consumers (webhooks, EDI, ERP, Kafka when needed) read from the outbox. No message broker required for small sites. |

## Modules

| Module | Owns | Status |
|---|---|---|
| platform | config, DB access, auth guard, problem+json errors, outbox and event feed, migrations | ✅ |
| tenancy | tenants, complexes, facilities, yards, blocks, partners | ✅ |
| inventory | units, holds, yard allocation, ISO 6346 / ISO 3779 checks | ✅ |
| vessel | vessels, visits, load/discharge lists, discharge moves | ✅ (load moves next) |
| gate | gate in/out with hold checks and trouble-lane rejects | ✅ |
| billing | tariffs, charge accrual from events, invoices | ✅ (ERP export next) |
| edi | EDIFACT syntax, COPRAR in, COARRI/CODECO out, message log | ✅ (more messages next) |
| customs | WCO DM adapter, ASYCUDA / Single Window connectors | planned |
| optimisation | yard allocation and dispatch optimisers behind the `YardAllocator` seam | planned |
| equipment | CHE pools, work queues, handheld (HHT) app | planned |
| cargo modules | break-bulk tally, RoRo lanes and damage, liquid nominations and meter tickets | core supports them; workflows planned |

## Multi-tenancy

- Tenant isolation in the database: every tenant table has `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `tenant_id = current_tenant()`.
- The API connects as `tos_app`, which never owns tables; migrations run as `tos_owner`.
- Each request runs in one transaction that first sets `app.tenant_id` (transaction-local) from the verified token.
- SaaS: shared database with RLS by default; a large tenant can get its own database (same schema, same image). On-prem: one tenant, same code.

## Identity and access

```
Customer IdP (Entra ID, Okta, ADFS, Google, UAE PASS)
        │ SAML 2.0 / OIDC federation
        ▼
Identity broker (Keycloak realm per tenant)  ──►  OIDC access token (JWT)
        │                                            iss = tenant realm
        ▼                                            realm_access.roles = tos:*
TOS API: verify signature via OIDC discovery/JWKS,   facilities = [codes] (optional)
map issuer → tenant, check roles and facility scope
```

- Roles: `tos:admin` (implies all), `tos:planner`, `tos:operator`, `tos:gate`, `tos:billing`, `tos:edi`, `tos:viewer`; `platform:admin` from the platform realm provisions tenants.
- Machine partners use OAuth client credentials (example client `tos-edi-partner` in the demo realm); mTLS can be added at the ingress.
- Handhelds and kiosks: OAuth device authorization flow through the broker.
- Provisioning: SCIM 2.0 / JIT through the broker (planned).
- `TRUSTED_ISSUER_PREFIXES` limits which issuers are even considered; tokens are rejected if expired, unsigned by the issuer's keys, or from an unknown issuer.

## Deployment

| | SaaS | On-prem |
|---|---|---|
| Runtime | Kubernetes, N replicas of the same image | Docker Compose on one server, or the customer's Kubernetes |
| Database | Managed PostgreSQL per region (data residency per tenant) | Local PostgreSQL |
| Identity | Shared Keycloak, realm per tenant, customer IdP federated | Bundled Keycloak, or the customer's IdP directly |
| Upgrades | Rolling; migrations run once (advisory lock) | Same image, migrations on start |

## Event flow

`write + outbox event (same tx)` → in-transaction handlers (billing accrual) → `GET /v1/events?after=` feed → planned dispatcher for webhooks, EDI generation, ERP export and optional Kafka.
