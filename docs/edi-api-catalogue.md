# EDI ↔ API catalogue

Rule: **every standard message has a REST endpoint and a domain event.** EDI is a translation layer onto the same services the API uses; no business logic lives in a mapper. Partners choose EDI, REST, webhooks/event feed, or a mix.

Status: ✅ implemented · 🟡 API/event implemented, EDI mapper planned · ⬜ planned

| EDI message | Purpose | Dir | REST API (`/v1`) | Event | Status |
|---|---|---|---|---|---|
| COPRAR | Load / discharge order | in | `POST /visits/{id}/load-lists` | `loadlist.updated` | ✅ |
| COARRI | Load / discharge report | out | `GET /visits/{id}/moves`, `POST /visits/{id}/loads` | `unit.discharged`, `unit.loaded` | ✅ (discharge and load, with stow cell `LOC+147`) |
| CODECO | Gate in / out report | out | `POST /gate/transactions` | `unit.gated-in`, `unit.gated-out` | ✅ |
| BAPLIE | Bay plan | in/out | `PUT /visits/{id}/bayplan` | `bayplan.received` | ⬜ |
| MOVINS | Stowage instructions | in | `PUT /visits/{id}/stowage` | `stowage.received` | ⬜ |
| COPARN | Booking, pre-advice, release | in | `POST /bookings` | `booking.created` | ⬜ |
| COREOR | Release order | in | `POST /releases` | `release.granted` | ⬜ |
| COHAOR | Special handling order | in | `POST /service-orders` | `service.ordered` | ⬜ |
| COSTCO / COSTOR | Stuffing / stripping | in/out | `POST /cfs-orders` | `cfs.completed` | ⬜ |
| VERMAS | Verified gross mass (SOLAS) | in | `PUT /units/{id}/vgm`, or `vgm` on gate-in | `unit.vgm-set` | ✅ |
| IFTDGN | Dangerous goods notification | in | `POST /dg-declarations` | `dg.declared` | ⬜ (IMDG fields exist) |
| CUSCAR / CUSRES | Customs cargo report / response | in/out | `POST /units/{id}/holds`, `.../release` | `hold.applied`, `hold.released` | 🟡 |
| BERMAN / CALINF | Berth request / call information | in | `POST /visits` | `vessel-call.updated` | 🟡 |
| VESDEP | Vessel departure | out | `POST /visits/{id}/depart` (loaded units leave, unworked moves cancelled) | `vessel.departed` | 🟡 |
| IFTMIN | Transport instruction | in | `POST /transport-orders` | `transport-order.created` | ⬜ |
| IFTSTA | Status report (RoRo, general cargo) | out | `GET /units/{id}` | `cargo.status-changed` | ⬜ |
| DESTIM | Damage / repair estimate | out | `GET /units/{id}/damages` | `unit.damaged` | ⬜ |
| TPFREP | Terminal performance | out | `GET /reports/performance` | — | ⬜ |
| INVOIC | Invoice | out | `POST /invoices`, `GET /invoices/{id}` | `invoice.issued` | 🟡 |
| APERAK / CONTRL | Acknowledgement / error | out | problem+json on every API error; `REJECTED` answer on `/edi/inbound` | `message.rejected` | 🟡 |
| ANSI X12 301/315/322 | US carrier equivalents | in/out | same endpoints | same events | ⬜ |
| DCSA Track & Trace, JIT Port Call | Carrier/port APIs | native | `/dcsa/*` | DCSA events | ⬜ |

## EDI endpoints

- `POST /v1/edi/inbound` — body is the raw interchange (`Content-Type: application/edifact` or `text/plain`), `X-Facility` selects the terminal. Response is APERAK-style JSON: `ACCEPTED` with the result, or `REJECTED` with the reason. Every message is stored in `edi_messages`, including rejected ones.
- `GET /v1/edi/outbound/coarri/{visitId}?kind=DISCHARGE|LOAD`: discharge or load report for a visit.
- `GET /v1/edi/outbound/codeco/{gateTransactionId}` — gate report.

## Partner profiles

Defaults follow the SMDG message implementation guides. Version strings and BGM document codes live in `src/edi/messages.ts` (`PROFILE`) and will move to per-tenant partner profiles: EDIFACT directory (D95B … D16A), association code, code lists, and transport (SFTP, AS2, MQ). **Confirm qualifiers against each partner's MIG during onboarding.**

## COPRAR mapping (v1)

| Segment | Field |
|---|---|
| `TDT+20` element 2 / `RFF+VON` | voyage → matches `voyage_in` or `voyage_out` of an open visit |
| `TDT` element 8 (`:146` IMO, `:103` call sign) | vessel identity |
| `EQD+CN` | container number, ISO type, full (5) / empty (4) |
| `LOC+9` / `LOC+11` | POL / POD; POD = this facility ⇒ discharge, POL = this facility ⇒ load |
| `MEA+AAE+G` / `MEA+AAE+VGM` | gross weight / VGM (kg) |
| `NAD+CF` | container operator (line) |
| `DGS+IMD` | IMDG class and UN number |
| `TMP` | reefer |
| `SEL` | seal numbers |

## VERMAS mapping (v1)

| Segment | Field |
|---|---|
| `EQD+CN` | container number (must be active at the facility) |
| `MEA+AAE+VGM` | verified gross mass, kg (required) |
| `DOC` (`SM1`/`SM2`) | SOLAS weighing method |
| `NAD+SPC` | responsible party / signatory |
| `DTM+798` | VGM determination time |
