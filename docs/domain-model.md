# Domain model

One model for every cargo type. Containers, break-bulk lots, vehicles and liquid parcels are all **units**; what differs is how they are identified, stored, measured and charged. Cargo-type modules add behaviour on top of this shared core; they never fork it.

## Tenancy hierarchy

```
Tenant ─┬─ Complex ─┬─ Facility (terminal) ─┬─ Yard ─┬─ Yard block ── slot / position
        │           │                       │        └─ ...
        │           │                       └─ ...
        ├─ Partners (lines, agents, hauliers, customers)
        └─ IdP realm (OIDC issuer)
```

| Level | Table | Notes |
|---|---|---|
| Tenant | `tenants` | A customer of the platform (port operator). One IdP realm/issuer each. Platform-level, no RLS. |
| Complex | `complexes` | A port or group of terminals run by the tenant. |
| Facility | `facilities` | A terminal: type (`MULTIPURPOSE`, `CONTAINER`, `BREAKBULK`, `RORO`, `LIQUID_BULK`), UN/LOCODE, SMDG terminal code, time zone, billing currency. |
| Yard | `yards` | A storage area within a facility. |
| Yard block | `yard_blocks` | `CONTAINER_STACK` (bays × rows × tiers), `LAYDOWN` (m² capacity), `RORO_LANE` (vehicle capacity), `TANK` (m³ capacity). |

Every tenant-owned row carries `tenant_id`; PostgreSQL row-level security (`FORCE ROW LEVEL SECURITY`) filters every query by `current_setting('app.tenant_id')`, which the API sets per transaction from the verified token. A bug in a query cannot leak another tenant's data.

Users are scoped further by facility: the token's `facilities` claim lists the facility codes they may use (absent = all), and operational endpoints act on the facility named in the `X-Facility` header.

## Core entities

| Entity | Table | Key fields | Lifecycle |
|---|---|---|---|
| Partner | `partners` | code (SMDG line code / customer code), roles, `is_aeo` (WCO SAFE AEO), ERP customer ref | — |
| Vessel | `vessels` | IMO number (7 digits), name, call sign, vessel type | — |
| Vessel visit | `vessel_visits` | visit ref, voyage in/out, line operator, berth, ETA/ETD/ATA/ATD | `PLANNED → ARRIVED → WORKING → COMPLETED → DEPARTED` (or `CANCELLED`) |
| Unit | `units` | `cargo_kind`, `unit_ref`, ISO type, freight kind, category, weight/VGM, quantity + UoM, POL/POD, IMDG class + UN no., reefer, seals, yard position | `ADVISED → IN_YARD → LOADED/DEPARTED` |
| Hold | `unit_holds` | type (`CUSTOMS`, `LINE`, `TERMINAL`, `DG`, `INSPECTION`), reference (e.g. ASYCUDA declaration), applied/released by/at | active until released |
| Work instruction | `work_instructions` | move kind (`DISCHARGE`, `LOAD`, `YARD_SHIFT`, `GATE_IN`, `GATE_OUT`), from/to position, equipment (CHE) | `PLANNED → COMPLETED` |
| Gate transaction | `gate_transactions` | direction, unit ref, truck plate, haulier, status, reject reason | `COMPLETED` or `REJECTED` (trouble lane) |
| EDI message | `edi_messages` | direction, type, interchange ref, partner, raw text, status, error | `ACCEPTED`, `REJECTED`, `GENERATED` |
| Tariff | `tariffs` | charge code, cargo kind, trigger event, basis, rate, currency, free days, validity; optional facility and customer | — |
| Charge | `charges` | unit, customer, tariff, quantity × rate = amount, event | accrues → invoiced |
| Invoice | `invoices` | number, customer, currency, total, ERP export status | `FINAL` (→ ERP) |
| Domain event | `outbox_events` | type, aggregate, payload, actor, time | published by dispatcher |

## Cargo kinds

| Kind | `unit_ref` | Identity check | Stored in | Typical billing basis |
|---|---|---|---|---|
| `CONTAINER` | container number | ISO 6346 owner/category/serial + check digit; ISO type code required | `CONTAINER_STACK` slot `A1-03-02-1` | per box, per TEU, per day |
| `BREAKBULK` | lot / B/L line ref | — | `LAYDOWN` position | per tonne, per m³, per day |
| `VEHICLE` | VIN | ISO 3779 (17 chars, no I/O/Q) | `RORO_LANE` position | per unit, per day |
| `LIQUID` | parcel / nomination ref | quantity in m³ or MT required | `TANK` | per m³, per tonne (throughput) |

A container number can be active only once per facility (partial unique index); after departure the record is history and the number can be advised again.

## Unit category

`IMPORT` (discharged, leaves by land), `EXPORT` (arrives by land, loaded), `TRANSSHIP` (vessel to vessel), `STORAGE` (land in, land out). The gate and billing rules use it: only `IMPORT`/`STORAGE` units may leave by truck; only `EXPORT`/`STORAGE` units may enter.

## Billing model

Charges accrue **in the same database transaction** as the operational event (`unit.discharged`, `unit.loaded`, `unit.gated-in`, `unit.gated-out`, and `storage` evaluated at gate-out). Tariff selection per charge code:

1. customer contract rate beats the standard rate,
2. facility-specific beats tenant-wide,
3. latest `valid_from` that covers the event date.

Quantity by basis: `PER_UNIT` 1; `PER_TEU` from the ISO length code (20' = 1, 40'/45' = 2); `PER_TONNE` from gross weight or MT quantity; `PER_M3` from m³ quantity; `PER_DAY` = ceil(days in yard) − free days. Invoices group a customer's uninvoiced charges per currency and emit `invoice.issued`, which the ERP connector (Oracle) consumes.

## Concepts from the reference systems

The model takes vocabulary that operators already know from N4 and CATOS (unit, visit, work instruction, hold, gate transaction, tariff/charge) but is designed independently. No schema or code is copied from either product.
