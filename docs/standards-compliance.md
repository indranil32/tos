# Customs and maritime standards

## Customs: WCO Data Model and ASYCUDA

ASYCUDA World (UNCTAD) is a customs management system, not the WCO Data Model itself; it has its own XML and EDIFACT interfaces, aligned with the WCO Data Model. The TOS therefore talks to customs through one **customs adapter**:

```
TOS customs events ──► Customs adapter (WCO Data Model mapping) ──► connector per system
(manifest, hold,                                                    ├─ ASYCUDA World
 release, inspection)                                               ├─ National Single Window / PCS
                                                                    └─ other customs systems
```

| Direction | TOS side | WCO DM / customs side |
|---|---|---|
| out | manifest / discharge list (`loadlist.updated`, `unit.discharged`) | cargo report (CUSCAR / ASYCUDA manifest) |
| in | `POST /v1/units/{id}/holds` (`CUSTOMS`, reference = declaration no.) | customs hold / selectivity result (CUSRES) |
| in | `POST /v1/units/{id}/holds/{holdId}/release` | release / clearance |
| in | hold type `INSPECTION` | physical examination request |
| data | `partners.is_aeo` | WCO SAFE Framework AEO status |

Gate-out is blocked while any hold is active (implemented and tested).

## Maritime and port standards

| Area | Standard | In the platform |
|---|---|---|
| Container identity | ISO 6346 | Owner code, category, serial and check digit validated on every load list; size/type code validated; TEU derived from the length code |
| Vehicle identity | ISO 3779 | VIN format validated for `VEHICLE` units |
| Locations | UN/LOCODE | Facility, POL, POD validated |
| Terminal and line codes | SMDG code lists | Facility `smdg_code`, partner codes; used in EDI envelopes |
| EDI syntax | UN/EDIFACT (ISO 9735), SMDG MIGs | Parser/writer with UNA and release-character handling; COPRAR, COARRI, CODECO |
| Dangerous goods | IMDG Code | IMDG class and UN number stored; UN number required when a class is given. Segregation checks: planned |
| Weight | SOLAS VGM | VGM with method (SM1/SM2), signatory and time, from API, gate-in or VERMAS. Loading a packed container without VGM is blocked (tested); empties are exempt |
| Port call | IMO FAL Convention, Maritime Single Window | Visit data (IMO, call sign, ETA/ETD/ATA/ATD). FAL forms export: planned |
| Port call timestamps | IHO S-211, DCSA JIT Port Call | Planned on the visit API |
| Security | ISPS Code, ISO 28000 | Gate transactions with truck plate and haulier, full audit via the event log |
| Liquid bulk | ISGOTT, API MPMS | `LIQUID` units in m³/MT and `TANK` blocks; ship-shore checklist and metered transfer: planned |
| Single Window | UN/CEFACT Rec. 33 | Integration via the customs adapter and PCS connector |
| Information security | ISO 27001, SOC 2 | Controls for the SaaS service: tenant isolation in the database, OIDC, audit trail |

Standards versions should be confirmed with the relevant authorities before they go into a requirements baseline.
