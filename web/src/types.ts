export interface Visit {
  id: string; visitRef: string; phase: string; imo: string; vesselName: string; vesselType?: string; lineOperator: string | null;
  voyageIn: string | null; voyageOut: string | null; berth: string | null; eta: string | null; etd: string | null;
  ata: string | null; atd: string | null; plannedMoves: number; completedMoves: number; discharged?: number; loaded?: number;
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
