# Data colour coding

> Generated from `web/src/theme/colors.ts` by `npm run colors:doc`. Do not edit by hand: change the source file and regenerate. CI fails if this document is out of date.

Every screen of the TOS colours data the same way, so a planner, a gate clerk and a billing officer read a colour identically. This document is the reference for designers, developers and trainers.

## The three rules

1. **One value, one colour, on every screen.** "In yard" is the same blue on the units list, the unit detail, the dashboard and the colour guide.
2. **Shape tells you the kind of value.**
   - A **filled badge with an icon** is a **status**: where something is in its life cycle (Advised, Working, Rejected).
   - An **outlined chip with a colour bar** is a **category**: what something is (Import, Container, Vehicle).
   - A **pill with a symbol** is a **special-handling flag**: dangerous goods, reefer, hold, missing VGM.
3. **Colour is never the only signal.** Every badge carries a text label and an icon, every coloured view (yard, charts) shows a legend, and tooltips explain the meaning.

## Status tones

All statuses map onto six tones. The tone carries the meaning; the label says which state it is.

| Tone | Icon | Meaning | Background | Text | Border | Solid (bars, cells, row accent) | Text contrast |
|---|---|---|---|---|---|---|---|
| **Planned** | ○ | Known and expected, nothing has happened yet (advised, planned, draft). | `#EEF1F5` | `#36414F` | `#9AA7B8` (dashed) | `#9AA7B8` | 9.1:1 |
| **In progress** | ● | Happening now or currently held by the terminal (vessel working, unit in yard). | `#E3EEFB` | `#0B4F9C` | `#8DB8EA` | `#2F7BD6` | 6.8:1 |
| **Done** | ✓ | Finished successfully (loaded, gate completed, message accepted, invoice final). | `#E2F4EA` | `#14663A` | `#8FCFAA` | `#2E9E5F` | 6.1:1 |
| **Needs attention** | ! | Waiting on someone or something; not blocked yet (ERP export pending, uninvoiced charges, missing VGM). | `#FFF3D6` | `#734600` | `#EDBF5E` | `#E0A01B` | 7.3:1 |
| **Blocked / failed** | ✕ | Cannot proceed until someone acts (hold, rejected gate visit, failed message). | `#FDE4E1` | `#9E1F18` | `#EE9A92` | `#D23A2F` | 6.5:1 |
| **Closed** | – | History: left the terminal, departed or cancelled. Shown muted. | `#F1F1F1` | `#5E5E5E` | `#D3D3D3` | `#B5B5B5` | 5.7:1 |

"Planned" uses a dashed border so it can be told apart from "Closed" without relying on colour.

## Statuses by domain

### Unit state

Shown on: Units, vessel moves, yard, gate, unit detail.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `ADVISED` | ○ Advised | Planned | Announced by load list, booking or COPRAR; not in the terminal yet. |
| `IN_YARD` | ● In yard | In progress | Physically in the terminal. |
| `LOADED` | ✓ Loaded | Done | On board the outbound vessel. |
| `DEPARTED` | – Departed | Closed | Left the terminal (truck, vessel departure or not discharged). |

### Vessel visit phase

Shown on: Vessel visits, dashboard, visit detail.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `PLANNED` | ○ Planned | Planned | Expected call; not arrived. |
| `ARRIVED` | ● Arrived | In progress | Alongside or at anchor, operations not started. |
| `WORKING` | ● Working | In progress | Cranes working the vessel. |
| `COMPLETED` | ✓ Completed | Done | All moves done, not yet sailed. |
| `DEPARTED` | – Departed | Closed | Sailed. |
| `CANCELLED` | – Cancelled | Closed | Call cancelled. |

### Move (work instruction) status

Shown on: Visit moves, work queues, machine console.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `PLANNED` | ○ Planned | Planned | Move planned, waiting in its queue. |
| `DISPATCHED` | ● Dispatched | In progress | Sent to a machine; not started yet. |
| `IN_PROGRESS` | ● In progress | In progress | The machine is doing the move. |
| `COMPLETED` | ✓ Completed | Done | Move confirmed. |
| `CANCELLED` | – Cancelled | Closed | Move cancelled (e.g. at departure). |

### Cell on the bay plan

Shown on: Vessel visit: bay plan.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `DISCHARGE` | ○ To discharge | Planned | For this port; comes off the vessel. |
| `LOAD` | ○ To load | Planned | Planned into this cell; goes on the vessel here. |
| `RESTOW` | ! Restow | Needs attention | Stays on board but must come off and go back on to reach cargo for this port. |
| `DISCHARGED` | ✓ Discharged | Done | Taken off at this port. |
| `LOADED` | ✓ Loaded | Done | Loaded at this port. |
| `RESTOWED` | ✓ Restowed | Done | Taken off and put back on board. |
| `ROB` | – On board | Closed | Remains on board; no move here. |

### Equipment status

Shown on: Equipment, work queues, machine console.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `IDLE` | ○ Idle | Planned | Logged on and available for the next job. |
| `WORKING` | ● Working | In progress | Holding or doing a job. |
| `MAINTENANCE` | ! Maintenance | Needs attention | Planned service; jobs go back to their queues. |
| `BREAKDOWN` | ✕ Breakdown | Blocked / failed | Out of service; its jobs were re-routed to other machines. |
| `OFFLINE` | – Offline | Closed | No operator logged on. |

### Work queue status

Shown on: Work queues.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `ACTIVE` | ● Active | In progress | Machines take jobs from this queue. |
| `SUSPENDED` | ! Suspended | Needs attention | Paused by the planner or control room; no new jobs are dispatched. |
| `CLOSED` | – Closed | Closed | Finished; remaining planned moves were taken out of the queue. |

### Gate lane status

Shown on: Terminal.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `OPEN` | ● Open | In progress | Lane in use. |
| `CLOSED` | – Closed | Closed | Lane closed. |

### Gate transaction status

Shown on: Gate, unit detail.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `COMPLETED` | ✓ Completed | Done | Truck processed. |
| `REJECTED` | ✕ Rejected | Blocked / failed | Sent to the trouble lane; reason recorded. |

### Hold state

Shown on: Unit detail, units list.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `ACTIVE` | ✕ On hold | Blocked / failed | Blocks gate-out and loading. |
| `RELEASED` | ✓ Released | Done | Hold lifted. |

### Invoice status

Shown on: Invoices.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `DRAFT` | ○ Draft | Planned | Not issued. |
| `FINAL` | ✓ Final | Done | Issued to the customer. |
| `CANCELLED` | – Cancelled | Closed | Cancelled invoice. |

### ERP export status

Shown on: Invoices.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `PENDING` | ! Pending | Needs attention | Waiting to be sent to the ERP. |
| `EXPORTED` | ✓ Exported | Done | In the ERP. |
| `FAILED` | ✕ Failed | Blocked / failed | ERP rejected it; needs action. |

### EDI message status

Shown on: EDI messages.

| Value | Label | Tone | Meaning |
|---|---|---|---|
| `ACCEPTED` | ✓ Accepted | Done | Inbound message processed. |
| `GENERATED` | ✓ Generated | Done | Outbound message produced. |
| `REJECTED` | ✕ Rejected | Blocked / failed | Inbound message refused; APERAK-style reason recorded. |

## Categories

Categories are shown as outlined chips with a colour bar and an icon. Unit category uses the Okabe-Ito colour-blind-safe palette and is also the default colouring of the yard view.

### Unit category (trade direction)

Shown on: Units, yard (default colouring), gate.

| Value | Icon | Label | Colour | Text on fill | Meaning |
|---|---|---|---|---|---|
| `IMPORT` | ↓ | Import | `#0072B2` | white (5.2:1) | Discharged here, leaves by land. |
| `EXPORT` | ↑ | Export | `#E69F00` | black (8.4:1) | Arrives by land, leaves by vessel. |
| `TRANSSHIP` | ⇄ | Transship | `#CC79A7` | black (6.2:1) | Vessel to vessel. |
| `STORAGE` | ▤ | Storage | `#009E73` | black (5.5:1) | Land in, land out. |

### Cargo kind

Shown on: Units, visits, gate, yard tooltips.

| Value | Icon | Label | Colour | Text on fill | Meaning |
|---|---|---|---|---|---|
| `CONTAINER` | ▣ | Container | `#3B5BA5` | white (6.5:1) | ISO container (ISO 6346). |
| `BREAKBULK` | ▥ | Break-bulk | `#8C6A3B` | white (5.0:1) | General cargo lot. |
| `VEHICLE` | ◈ | Vehicle | `#7B4FA0` | white (6.1:1) | RoRo unit (ISO 3779 VIN). |
| `LIQUID` | ◍ | Liquid bulk | `#1C7F80` | white (4.8:1) | Tank parcel (m³ / t). |

### Yard area type

Shown on: Terminal map, yard.

| Value | Icon | Label | Colour | Text on fill | Meaning |
|---|---|---|---|---|---|
| `CONTAINER_STACK` | ▣ | Container stack | `#3B5BA5` | white (6.5:1) | Bays, rows and tiers; counted in slots. |
| `LAYDOWN` | ▥ | Laydown | `#8C6A3B` | white (5.0:1) | Open area for break-bulk and project cargo; m². |
| `RORO_LANE` | ◈ | RoRo lanes | `#7B4FA0` | white (6.1:1) | Parking lanes for vehicles; vehicles or lane-metres. |
| `TANK` | ◍ | Tank | `#1C7F80` | white (4.8:1) | Liquid bulk storage; m³. |
| `WAREHOUSE` | ▦ | Warehouse / CFS shed | `#5F6B2A` | white (5.8:1) | Covered storage, stuffing and stripping; pallets. |

### Facility kind

Shown on: Terminal, facility selector.

| Value | Icon | Label | Colour | Text on fill | Meaning |
|---|---|---|---|---|---|
| `SEAPORT` | ⚓ | Seaport | `#0072B2` | white (5.2:1) | Vessel calls at the quay. |
| `DRY_PORT` | ⛟ | Dry port | `#A35A00` | white (5.2:1) | Inland terminal linked to a seaport by rail or road. |
| `DEPOT` | ▤ | Container depot | `#007A5A` | white (5.3:1) | Empty containers: survey, repair, storage, release. |
| `CFS` | ▦ | CFS | `#9E4A7D` | white (5.6:1) | Container freight station: LCL stuffing and stripping. |

### Direction

Shown on: Gate, EDI messages.

| Value | Icon | Label | Colour | Text on fill | Meaning |
|---|---|---|---|---|---|
| `IN` | → | In | `#4A5568` | white (7.5:1) | Into the terminal / received. |
| `OUT` | ← | Out | `#4A5568` | white (7.5:1) | Out of the terminal / sent. |

## Special-handling flags

Flags appear next to a unit wherever it is listed, always in this order: hold, dangerous goods, reefer, missing VGM.

| Flag | Symbol | Background | Text | Contrast | Meaning |
|---|---|---|---|---|---|
| **Dangerous goods** | ◆ | `#FFE6D2` | `#8F3A00` | 6.3:1 | IMDG class and UN number; segregation applies. |
| **Reefer** | ❄ | `#DDF3F9` | `#05586B` | 7.0:1 | Temperature controlled; needs power. |
| **Hold** | ⛔ | `#FDE4E1` | `#9E1F18` | 6.5:1 | Active hold (customs, line, terminal, DG, inspection). |
| **No VGM** | ⚖ | `#FFF3D6` | `#734600` | 7.3:1 | Packed export without verified gross mass: cannot load (SOLAS). |

## Row accents in lists

Every list draws a 4-pixel bar on the left of each row in the **solid** colour of the row's main status, so a long list can be scanned without reading the badges:

- **Units:** an active hold wins (Blocked red), otherwise the unit state tone.
- **Vessel visits:** visit phase. **Moves:** move status. **Gate:** gate status. **EDI:** message status.
- **Invoices:** ERP export status (pending exports stand out in amber). **Uninvoiced charges:** always "Needs attention".

## Yard colouring

The yard view can be coloured four ways. The choice is remembered per user and the legend always shows what the colours mean.

| Colour by | Rule |
|---|---|
| **Category** (default) | Unit category colours above. |
| **Line** | Lines get stable colours from the palette below, assigned in alphabetical order of line code. |
| **Dwell time** | One purple ramp, light to dark, so it never reads as a status. |
| **Holds & special cargo** | Hold = Blocked solid `#D23A2F`, then dangerous goods `#F0A066`, then reefer `#86CDE0`, otherwise light grey. |

Dwell-time ramp:

| Band | Fill | Text | Contrast |
|---|---|---|---|
| 0–3 days | `#EDE5F5` | `#3C2A55` | 10.4:1 |
| 4–7 days | `#CDB6E3` | `#2E1F44` | 8.2:1 |
| 8–14 days | `#7E58B3` | `#FFFFFF` | 5.3:1 |
| 15+ days | `#5E3D8F` | `#FFFFFF` | 8.3:1 |

Line palette (in assignment order): `#0072B2`, `#E69F00`, `#009E73`, `#CC79A7`, `#56B4E9`, `#D55E00`, `#7A6A00`, `#555555`.

A stack in the yard shows its top container's colour and the stack height (for example `3/4`); a ⛔ in the corner marks a hold anywhere in that cell.

## Dashboard

Each KPI tile has a top border in the tone of what it measures: vessels and yard occupancy are "In progress" (occupancy turns "Needs attention" above 85%), units on hold are "Blocked" (or "Done" when there are none), and the gate is "Done".

## Accessibility

- Every badge, chip and pill meets WCAG 2.1 AA contrast for its text (4.5:1 or better); the ratios are in the tables above and are checked by automated tests.
- Category colours come from the Okabe-Ito palette, which stays distinguishable for the common types of colour blindness.
- Status and category never rely on colour alone: icons, labels, dashed borders and legends carry the same information.

## Changing the colours

1. Edit `web/src/theme/colors.ts`. Add new statuses to the right domain, and map them to one of the six tones rather than inventing a new colour.
2. Run `npm test` in `web/`: the contrast and consistency tests must pass.
3. Run `npm run colors:doc` and commit the regenerated `docs/color-coding.md`.
4. The in-app **Colour guide** page renders from the same file, so it updates automatically.
