/**
 * TOS data colour coding: the single source of truth.
 *
 * Every screen renders statuses, categories and flags through this file (StatusBadge, CategoryChip,
 * FlagPill, Legend, the yard view), and docs/color-coding.md is generated from it
 * (npm run colors:doc). Change a colour here and it changes everywhere, including the document.
 *
 * Three rules:
 *  1. One value, one colour, on every screen.
 *  2. Shape says what kind of thing it is: a FILLED badge with an icon is a status (where something is
 *     in its life cycle); an OUTLINED chip with a colour bar is a category (what something is);
 *     a PILL with a symbol is a special-handling flag (dangerous goods, reefer, hold).
 *  3. Colour is never the only signal: every badge carries a text label and an icon, and every
 *     coloured view (yard) shows a legend.
 */

export type ToneKey = 'planned' | 'active' | 'done' | 'attention' | 'blocked' | 'closed';

export interface Tone {
  key: ToneKey;
  label: string;
  icon: string;
  meaning: string;
  bg: string;
  fg: string;
  border: string;
  /** Solid colour for cells, bars and chart marks. */
  solid: string;
  borderStyle: 'solid' | 'dashed';
}

/** Status tones: the six states anything can be in. Light background, dark text (WCAG AA). */
export const TONES: Record<ToneKey, Tone> = {
  planned: {
    key: 'planned', label: 'Planned', icon: '○', borderStyle: 'dashed',
    meaning: 'Known and expected, nothing has happened yet (advised, planned, draft).',
    bg: '#EEF1F5', fg: '#36414F', border: '#9AA7B8', solid: '#9AA7B8',
  },
  active: {
    key: 'active', label: 'In progress', icon: '●', borderStyle: 'solid',
    meaning: 'Happening now or currently held by the terminal (vessel working, unit in yard).',
    bg: '#E3EEFB', fg: '#0B4F9C', border: '#8DB8EA', solid: '#2F7BD6',
  },
  done: {
    key: 'done', label: 'Done', icon: '✓', borderStyle: 'solid',
    meaning: 'Finished successfully (loaded, gate completed, message accepted, invoice final).',
    bg: '#E2F4EA', fg: '#14663A', border: '#8FCFAA', solid: '#2E9E5F',
  },
  attention: {
    key: 'attention', label: 'Needs attention', icon: '!', borderStyle: 'solid',
    meaning: 'Waiting on someone or something; not blocked yet (ERP export pending, uninvoiced charges, missing VGM).',
    bg: '#FFF3D6', fg: '#734600', border: '#EDBF5E', solid: '#E0A01B',
  },
  blocked: {
    key: 'blocked', label: 'Blocked / failed', icon: '✕', borderStyle: 'solid',
    meaning: 'Cannot proceed until someone acts (hold, rejected gate visit, failed message).',
    bg: '#FDE4E1', fg: '#9E1F18', border: '#EE9A92', solid: '#D23A2F',
  },
  closed: {
    key: 'closed', label: 'Closed', icon: '–', borderStyle: 'solid',
    meaning: 'History: left the terminal, departed or cancelled. Shown muted.',
    bg: '#F1F1F1', fg: '#5E5E5E', border: '#D3D3D3', solid: '#B5B5B5',
  },
};

export interface StatusValue {
  label: string;
  tone: ToneKey;
  meaning: string;
}

export interface StatusDomain {
  kind: 'status';
  label: string;
  where: string;
  values: Record<string, StatusValue>;
}

export interface CategoryValue {
  label: string;
  color: string;
  icon: string;
  meaning: string;
}

export interface CategoryDomain {
  kind: 'category';
  label: string;
  where: string;
  values: Record<string, CategoryValue>;
}

export interface FlagValue {
  label: string;
  icon: string;
  bg: string;
  fg: string;
  border: string;
  meaning: string;
}

const s = (label: string, tone: ToneKey, meaning: string): StatusValue => ({ label, tone, meaning });

/** Status domains: every life-cycle field in the system, mapped onto the six tones. */
export const STATUS_DOMAINS = {
  unitState: {
    kind: 'status', label: 'Unit state', where: 'Units, vessel moves, yard, gate, unit detail',
    values: {
      ADVISED: s('Advised', 'planned', 'Announced by load list, booking or COPRAR; not in the terminal yet.'),
      IN_YARD: s('In yard', 'active', 'Physically in the terminal.'),
      LOADED: s('Loaded', 'done', 'On board the outbound vessel.'),
      DEPARTED: s('Departed', 'closed', 'Left the terminal (truck, vessel departure or not discharged).'),
    },
  },
  visitPhase: {
    kind: 'status', label: 'Vessel visit phase', where: 'Vessel visits, dashboard, visit detail',
    values: {
      PLANNED: s('Planned', 'planned', 'Expected call; not arrived.'),
      ARRIVED: s('Arrived', 'active', 'Alongside or at anchor, operations not started.'),
      WORKING: s('Working', 'active', 'Cranes working the vessel.'),
      COMPLETED: s('Completed', 'done', 'All moves done, not yet sailed.'),
      DEPARTED: s('Departed', 'closed', 'Sailed.'),
      CANCELLED: s('Cancelled', 'closed', 'Call cancelled.'),
    },
  },
  moveStatus: {
    kind: 'status', label: 'Move (work instruction) status', where: 'Visit moves, work queues, machine console',
    values: {
      PLANNED: s('Planned', 'planned', 'Move planned, waiting in its queue.'),
      DISPATCHED: s('Dispatched', 'active', 'Sent to a machine; not started yet.'),
      IN_PROGRESS: s('In progress', 'active', 'The machine is doing the move.'),
      COMPLETED: s('Completed', 'done', 'Move confirmed.'),
      CANCELLED: s('Cancelled', 'closed', 'Move cancelled (e.g. at departure).'),
    },
  },
  equipmentStatus: {
    kind: 'status', label: 'Equipment status', where: 'Equipment, work queues, machine console',
    values: {
      IDLE: s('Idle', 'planned', 'Logged on and available for the next job.'),
      WORKING: s('Working', 'active', 'Holding or doing a job.'),
      MAINTENANCE: s('Maintenance', 'attention', 'Planned service; jobs go back to their queues.'),
      BREAKDOWN: s('Breakdown', 'blocked', 'Out of service; its jobs were re-routed to other machines.'),
      OFFLINE: s('Offline', 'closed', 'No operator logged on.'),
    },
  },
  queueStatus: {
    kind: 'status', label: 'Work queue status', where: 'Work queues',
    values: {
      ACTIVE: s('Active', 'active', 'Machines take jobs from this queue.'),
      SUSPENDED: s('Suspended', 'attention', 'Paused by the planner or control room; no new jobs are dispatched.'),
      CLOSED: s('Closed', 'closed', 'Finished; remaining planned moves were taken out of the queue.'),
    },
  },
  laneStatus: {
    kind: 'status', label: 'Gate lane status', where: 'Terminal',
    values: {
      OPEN: s('Open', 'active', 'Lane in use.'),
      CLOSED: s('Closed', 'closed', 'Lane closed.'),
    },
  },
  gateStatus: {
    kind: 'status', label: 'Gate transaction status', where: 'Gate, unit detail',
    values: {
      COMPLETED: s('Completed', 'done', 'Truck processed.'),
      REJECTED: s('Rejected', 'blocked', 'Sent to the trouble lane; reason recorded.'),
    },
  },
  holdState: {
    kind: 'status', label: 'Hold state', where: 'Unit detail, units list',
    values: {
      ACTIVE: s('On hold', 'blocked', 'Blocks gate-out and loading.'),
      RELEASED: s('Released', 'done', 'Hold lifted.'),
    },
  },
  invoiceStatus: {
    kind: 'status', label: 'Invoice status', where: 'Invoices',
    values: {
      DRAFT: s('Draft', 'planned', 'Not issued.'),
      FINAL: s('Final', 'done', 'Issued to the customer.'),
      CANCELLED: s('Cancelled', 'closed', 'Cancelled invoice.'),
    },
  },
  erpExportStatus: {
    kind: 'status', label: 'ERP export status', where: 'Invoices',
    values: {
      PENDING: s('Pending', 'attention', 'Waiting to be sent to the ERP.'),
      EXPORTED: s('Exported', 'done', 'In the ERP.'),
      FAILED: s('Failed', 'blocked', 'ERP rejected it; needs action.'),
    },
  },
  ediStatus: {
    kind: 'status', label: 'EDI message status', where: 'EDI messages',
    values: {
      ACCEPTED: s('Accepted', 'done', 'Inbound message processed.'),
      GENERATED: s('Generated', 'done', 'Outbound message produced.'),
      REJECTED: s('Rejected', 'blocked', 'Inbound message refused; APERAK-style reason recorded.'),
    },
  },
} satisfies Record<string, StatusDomain>;

/**
 * Category palettes. Okabe-Ito colour-blind-safe hues for unit category (also the default yard colouring);
 * a separate earthier set for cargo kind, always shown with its icon.
 */
export const CATEGORY_DOMAINS = {
  category: {
    kind: 'category', label: 'Unit category (trade direction)', where: 'Units, yard (default colouring), gate',
    values: {
      IMPORT: { label: 'Import', color: '#0072B2', icon: '↓', meaning: 'Discharged here, leaves by land.' },
      EXPORT: { label: 'Export', color: '#E69F00', icon: '↑', meaning: 'Arrives by land, leaves by vessel.' },
      TRANSSHIP: { label: 'Transship', color: '#CC79A7', icon: '⇄', meaning: 'Vessel to vessel.' },
      STORAGE: { label: 'Storage', color: '#009E73', icon: '▤', meaning: 'Land in, land out.' },
    },
  },
  cargoKind: {
    kind: 'category', label: 'Cargo kind', where: 'Units, visits, gate, yard tooltips',
    values: {
      CONTAINER: { label: 'Container', color: '#3B5BA5', icon: '▣', meaning: 'ISO container (ISO 6346).' },
      BREAKBULK: { label: 'Break-bulk', color: '#8C6A3B', icon: '▥', meaning: 'General cargo lot.' },
      VEHICLE: { label: 'Vehicle', color: '#7B4FA0', icon: '◈', meaning: 'RoRo unit (ISO 3779 VIN).' },
      LIQUID: { label: 'Liquid bulk', color: '#1C7F80', icon: '◍', meaning: 'Tank parcel (m³ / t).' },
    },
  },
  blockType: {
    kind: 'category', label: 'Yard area type', where: 'Terminal map, yard',
    values: {
      CONTAINER_STACK: { label: 'Container stack', color: '#3B5BA5', icon: '▣', meaning: 'Bays, rows and tiers; counted in slots.' },
      LAYDOWN: { label: 'Laydown', color: '#8C6A3B', icon: '▥', meaning: 'Open area for break-bulk and project cargo; m².' },
      RORO_LANE: { label: 'RoRo lanes', color: '#7B4FA0', icon: '◈', meaning: 'Parking lanes for vehicles; vehicles or lane-metres.' },
      TANK: { label: 'Tank', color: '#1C7F80', icon: '◍', meaning: 'Liquid bulk storage; m³.' },
      WAREHOUSE: { label: 'Warehouse / CFS shed', color: '#5F6B2A', icon: '▦', meaning: 'Covered storage, stuffing and stripping; pallets.' },
    },
  },
  facilityKind: {
    kind: 'category', label: 'Facility kind', where: 'Terminal, facility selector',
    values: {
      SEAPORT: { label: 'Seaport', color: '#0072B2', icon: '⚓', meaning: 'Vessel calls at the quay.' },
      DRY_PORT: { label: 'Dry port', color: '#A35A00', icon: '⛟', meaning: 'Inland terminal linked to a seaport by rail or road.' },
      DEPOT: { label: 'Container depot', color: '#007A5A', icon: '▤', meaning: 'Empty containers: survey, repair, storage, release.' },
      CFS: { label: 'CFS', color: '#9E4A7D', icon: '▦', meaning: 'Container freight station: LCL stuffing and stripping.' },
    },
  },
  direction: {
    kind: 'category', label: 'Direction', where: 'Gate, EDI messages',
    values: {
      IN: { label: 'In', color: '#4A5568', icon: '→', meaning: 'Into the terminal / received.' },
      OUT: { label: 'Out', color: '#4A5568', icon: '←', meaning: 'Out of the terminal / sent.' },
    },
  },
} satisfies Record<string, CategoryDomain>;

/** Special-handling flags: pills with a symbol, shown next to the unit wherever it appears. */
export const FLAGS = {
  DG: { label: 'Dangerous goods', icon: '◆', bg: '#FFE6D2', fg: '#8F3A00', border: '#F0A066', meaning: 'IMDG class and UN number; segregation applies.' },
  REEFER: { label: 'Reefer', icon: '❄', bg: '#DDF3F9', fg: '#05586B', border: '#86CDE0', meaning: 'Temperature controlled; needs power.' },
  HOLD: { label: 'Hold', icon: '⛔', bg: '#FDE4E1', fg: '#9E1F18', border: '#EE9A92', meaning: 'Active hold (customs, line, terminal, DG, inspection).' },
  NO_VGM: { label: 'No VGM', icon: '⚖', bg: '#FFF3D6', fg: '#734600', border: '#EDBF5E', meaning: 'Packed export without verified gross mass: cannot load (SOLAS).' },
} satisfies Record<string, FlagValue>;

export type FlagKey = keyof typeof FLAGS;

/** Sequential ramp for dwell time in the yard (one hue, light to dark, so it never reads as a status). */
export const DWELL_RAMP = [
  { upTo: 3, label: '0–3 days', color: '#EDE5F5', fg: '#3C2A55' },
  { upTo: 7, label: '4–7 days', color: '#CDB6E3', fg: '#2E1F44' },
  { upTo: 14, label: '8–14 days', color: '#7E58B3', fg: '#FFFFFF' },
  { upTo: Infinity, label: '15+ days', color: '#5E3D8F', fg: '#FFFFFF' },
];

/** Line operators get stable colours from this colour-blind-safe list (assigned by code, alphabetically). */
export const LINE_PALETTE = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#7A6A00', '#555555'];

export type StatusDomainKey = keyof typeof STATUS_DOMAINS;
export type CategoryDomainKey = keyof typeof CATEGORY_DOMAINS;

export function statusOf(domain: StatusDomainKey, value: string | null | undefined): { value: StatusValue; tone: Tone } | null {
  if (!value) return null;
  const v = (STATUS_DOMAINS[domain].values as Record<string, StatusValue>)[value];
  return v ? { value: v, tone: TONES[v.tone] } : null;
}

export function categoryOf(domain: CategoryDomainKey, value: string | null | undefined): CategoryValue | null {
  if (!value) return null;
  return (CATEGORY_DOMAINS[domain].values as Record<string, CategoryValue>)[value] ?? null;
}

export function dwellBand(days: number) {
  return DWELL_RAMP.find((b) => days <= b.upTo)!;
}

/** Stable colour per line operator: sort the codes present, then assign palette entries in order. */
export function lineColors(codes: string[]): Record<string, string> {
  const sorted = [...new Set(codes.filter(Boolean))].sort();
  return Object.fromEntries(sorted.map((c, i) => [c, LINE_PALETTE[i % LINE_PALETTE.length]]));
}

// ---- WCAG helpers (used by tests and the document) ----
function channel(c: number) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Text colour for a solid fill. */
export function textOn(hex: string): string {
  return contrast(hex, '#FFFFFF') >= contrast(hex, '#111111') ? '#FFFFFF' : '#111111';
}
