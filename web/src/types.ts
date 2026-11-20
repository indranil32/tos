export interface Visit {
  id: string; visitRef: string; phase: string; imo: string; vesselName: string; vesselType?: string; lineOperator: string | null;
  voyageIn: string | null; voyageOut: string | null; berth: string | null; eta: string | null; etd: string | null;
  ata: string | null; atd: string | null; plannedMoves: number; completedMoves: number; discharged?: number; loaded?: number;
  etb?: string | null; quayFromM?: number | null; loaM?: number | null; sideTo?: string | null; movesPerHour?: number | null; stowCells?: number;
}

export interface Unit {
  id: string; cargoKind: string; unitRef: string; isoType: string | null; freightKind: string; category: string;
  grossWeightKg: string | null; quantity: string; quantityUom: string; state: string; yardPosition: string | null;
  pol: string | null; pod: string | null; dgClass: string | null; dgUnNumber: string | null; isReefer: boolean;
  timeIn: string | null; timeOut: string | null; vgmKg: string | null; vgmMethod: string | null; stowPosition: string | null;
  lineOperator: string | null; visitIn: string | null; visitOut: string | null; activeHolds: number; holdTypes: string | null;
  holds?: Hold[];
}

export interface Hold {
  id: string; holdType: string; reference: string | null; appliedBy: string; appliedAt: string; releasedBy: string | null; releasedAt: string | null;
}

export interface Move {
  id: string; moveKind: string; status: string; fromPosition: string | null; toPosition: string | null; cheId: string | null;
  completedAt: string | null; unitRef: string; cargoKind: string; isoType: string | null; freightKind: string; grossWeightKg: string | null;
}

export interface GateTx {
  id: string; direction: string; unitRef: string; truckPlate: string | null; haulier: string | null; status: string;
  rejectReason: string | null; createdAt: string; cargoKind: string | null; category: string | null;
}

export interface Invoice {
  id: string; invoiceNo: string; customer: string; customerName?: string; currency: string; total: string; status: string;
  erpExportStatus: string; issuedAt: string; lines: number | InvoiceLine[];
}

export interface InvoiceLine {
  chargeCode: string; description: string; unitRef: string; quantity: string; rate: string; amount: string; eventType: string; eventAt: string;
}

export interface Charge {
  id: string; customer: string; unitRef: string; chargeCode: string; quantity: string; rate: string; amount: string;
  currency: string; eventType: string; eventAt: string; invoiceId: string | null;
}

export interface EdiMessage {
  id: string; direction: string; messageType: string; interchangeRef: string | null; partner: string | null;
  status: string; error: string | null; bytes?: number; createdAt: string; raw?: string;
}

export interface DomainEventRow {
  id: number; type: string; aggregate_type: string; aggregate_id: string; facility: string | null;
  payload: Record<string, unknown>; actor: string | null; occurred_at: string;
}

export interface YardUnit {
  id: string; position: string; unitRef: string; cargoKind: string; category: string; freightKind: string; isoType: string | null;
  isReefer: boolean; dgClass: string | null; timeIn: string | null; lineOperator: string | null; activeHolds: number;
}

export interface YardBlock {
  id: string; code: string; yard: string; blockType: string; bays: number; rows: number; tiers: number; capacity: string | null;
  slots: number; occupied: number; units: YardUnit[];
}

export interface Partner { id: string; code: string; name: string; roles: string[] }

export interface Equipment {
  id: string;
  code: string;
  kind: string;
  pool: string | null;
  status: string;
  statusSince: string;
  statusReason: string | null;
  operator: string | null;
  position: string | null;
  maxWeightKg: number | null;
  twinLift: boolean;
  openJobs: number;
}

export interface WorkQueue {
  id: string;
  code: string;
  name: string;
  powKind: string;
  priority: number;
  status: string;
  visitRef: string | null;
  equipment: string | null;
  pool: string | null;
  planned: number;
  active: number;
  completed: number;
  createdAt: string;
}

export interface WorkInstruction {
  id: string;
  queue: string | null;
  sequence: number | null;
  moveKind: string;
  status: string;
  unitRef: string;
  isoType: string | null;
  cargoKind: string;
  visitRef: string | null;
  fromPosition: string | null;
  toPosition: string | null;
  plannedPosition: string | null;
  equipment: string | null;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  version: number;
}

export interface MapBox { x: number; y: number; w: number; h: number; angle: number }

export interface TerminalMap {
  facility: string;
  kinds: string[];
  berths: { id: string; code: string; name: string; berthKind: string; startMarkM: number; lengthM: number; depthM: number | null; bollardFrom: string | null; bollardTo: string | null; map: MapBox | null }[];
  blocks: { id: string; code: string; yard: string; blockType: string; bays: number; rows: number; tiers: number; capacity: number | null; capacityUnit: string | null; equipmentKind: string | null; allowedSizes: string[]; maxStackKg: number | null; reeferPlugs: number; dgClasses: string[]; occupied: number; map: MapBox | null }[];
  railTracks: { id: string; code: string; lengthM: number; maxWagons: number | null; map: MapBox | null }[];
  gateLanes: { id: string; code: string; direction: string; laneKind: string; hasOcr: boolean; status: string; map: MapBox | null }[];
  links: { id: string; fromFacility: string; toFacility: string; toKinds: string[]; mode: string; transitHours: number; bonded: boolean }[];
}

export interface BayCell {
  cell: string; bay: number; row: number; tier: number; deck: boolean;
  unitRef: string | null; isoType: string | null; weightKg: number | null; pol: string | null; pod: string | null;
  line: string | null; dgClass: string | null; isReefer: boolean; state: string; crane: string | null;
}

export interface BayPlan {
  visitRef: string;
  vesselName: string;
  profile: { maxBay: number; maxRow: number; holdTiers: number; deckTiers: number };
  counts: Record<string, number>;
  cells: BayCell[];
  unplannedLoads: { unitRef: string; isoType: string | null; pod: string | null; weightKg: number | null }[];
}

export interface CraneSplitResult {
  visitRef: string; movesPerHour: number; totalMoves: number; vesselHours: number; withoutCell: string[];
  cranes: { crane: string; craneStatus: string; queue: string; bayFrom: number | null; bayTo: number | null; moves: number; restows: number; hours: number }[];
}

export interface BerthPlanVisit {
  id: string; visitRef: string; phase: string; vesselName: string; vesselType: string; loaM: number | null; lineOperator: string | null;
  berth: string | null; quayFromM: number | null; eta: string | null; etb: string | null; etd: string | null; ata: string | null; atd: string | null;
  sideTo: string | null; openMoves: number; doneMoves: number;
}

export interface YardRange {
  id: string; name: string; block: string; bayFrom: number; bayTo: number; rowFrom: number; rowTo: number; purpose: string;
  visitRef: string | null; visitId: string | null; pod: string | null; line: string | null; size: string | null; weightClass: string | null;
  reefer: boolean | null; priority: number; occupied: number; slots: number;
}
