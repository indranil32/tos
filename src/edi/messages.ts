import { LoadListItem } from '../vessel/vessel.service';
import { edifactDateTime, el, EdifactError, Segment, writeEdifact } from './edifact';

/**
 * Message implementation profiles. Defaults follow the SMDG message implementation guides
 * (segment layout and code lists); per-partner profiles can override version and BGM codes.
 * Confirm codes against each trading partner's MIG during onboarding.
 */
export const PROFILE = {
  coarri: { version: ['COARRI', 'D', '95B', 'UN', 'ITG13'], bgmDischarge: '98', bgmLoad: '46' },
  codeco: { version: ['CODECO', 'D', '95B', 'UN', 'ITG14'], bgmGateIn: '34', bgmGateOut: '36' },
};

export interface Interchange {
  sender?: string;
  recipient?: string;
  ref?: string;
  messageType: string;
  segments: Segment[]; // UNH..UNT of the first message
}

export function splitInterchange(segments: Segment[]): Interchange {
  const unb = segments.find((s) => s.tag === 'UNB');
  const unhIdx = segments.findIndex((s) => s.tag === 'UNH');
  if (unhIdx < 0) throw new EdifactError('No UNH segment');
  const untIdx = segments.findIndex((s, i) => i > unhIdx && s.tag === 'UNT');
  if (untIdx < 0) throw new EdifactError('No UNT segment');
  const body = segments.slice(unhIdx, untIdx + 1);
  const declared = Number(el(segments[untIdx], 1));
  if (declared && declared !== body.length) throw new EdifactError(`UNT segment count ${declared} does not match ${body.length}`);
  return {
    sender: el(unb, 2),
    recipient: el(unb, 3),
    ref: el(unb, 5),
    messageType: el(segments[unhIdx], 2) ?? 'UNKNOWN',
    segments: body,
  };
}

export interface CoprarResult {
  voyage: string;
  vesselId?: string;
  vesselIdType: 'IMO' | 'CALL_SIGN' | 'OTHER';
  items: (LoadListItem & { _pol?: string; _pod?: string })[];
}

/** COPRAR (container discharge/loading order) -> load list items. Direction is resolved by the caller. */
export function mapCoprar(segs: Segment[]): CoprarResult {
  const tdt = segs.find((s) => s.tag === 'TDT');
  const voyage = el(tdt, 2) ?? el(segs.find((s) => s.tag === 'RFF' && el(s, 1, 0) === 'VON'), 1, 1);
  if (!voyage) throw new EdifactError('COPRAR has no voyage number (TDT or RFF+VON)');
  const vesselId = el(tdt, 8, 0);
  const idCode = el(tdt, 8, 1);
  const vesselIdType = idCode === '146' ? 'IMO' : idCode === '103' ? 'CALL_SIGN' : 'OTHER';

  const items: CoprarResult['items'] = [];
  let cur: CoprarResult['items'][number] | undefined;
  for (const s of segs) {
    switch (s.tag) {
      case 'EQD': {
        if (el(s, 1) !== 'CN') {
          cur = undefined;
          break;
        }
        const fe = el(s, 6);
        cur = {
          move: 'DISCHARGE', unitRef: (el(s, 2) ?? '').toUpperCase(), cargoKind: 'CONTAINER', isoType: el(s, 3),
          freightKind: fe === '4' ? 'MTY' : 'FCL', quantity: 1, quantityUom: 'UNIT', isReefer: false, seals: [],
        };
        items.push(cur);
        break;
      }
      case 'LOC':
        if (!cur) break;
        if (el(s, 1) === '9') cur._pol = el(s, 2);
        if (el(s, 1) === '11') cur._pod = el(s, 2);
        break;
      case 'MEA':
        if (cur && el(s, 1) === 'AAE' && ['G', 'VGM', 'AET'].includes(el(s, 2) ?? '')) {
          const kg = Number(el(s, 3, 1));
          if (!Number.isNaN(kg)) {
            if (el(s, 2) === 'VGM') cur.vgmKg = kg;
            else cur.grossWeightKg = kg;
          }
        }
        break;
      case 'NAD':
        if (cur && el(s, 1) === 'CF') cur.lineOperator = el(s, 2);
        break;
      case 'DGS':
        if (cur && el(s, 1) === 'IMD') {
          cur.dgClass = el(s, 2);
          cur.dgUnNumber = el(s, 3);
        }
        break;
      case 'TMP':
        if (cur) cur.isReefer = true;
        break;
      case 'SEL':
        if (cur && el(s, 1)) cur.seals.push(el(s, 1)!);
        break;
    }
  }
  if (!items.length) throw new EdifactError('COPRAR contains no containers (EQD+CN)');
  return { voyage, vesselId, vesselIdType, items };
}

export interface VermasEntry {
  unitRef: string;
  vgmKg: number;
  method?: 'SM1' | 'SM2';
  verifiedBy?: string;
  verifiedAt?: string;
}

/**
 * VERMAS (verified gross mass) -> VGM entries.
 * EQD+CN container, MEA+AAE+VGM weight, DOC method (SM1/SM2), NAD+SPC responsible party, DTM+798 determination time.
 */
export function mapVermas(segs: Segment[]): VermasEntry[] {
  const out: VermasEntry[] = [];
  let cur: VermasEntry | undefined;
  for (const s of segs) {
    if (s.tag === 'EQD') {
      cur = el(s, 1) === 'CN' ? { unitRef: (el(s, 2) ?? '').toUpperCase(), vgmKg: NaN } : undefined;
      if (cur) out.push(cur);
    } else if (!cur) continue;
    else if (s.tag === 'MEA' && el(s, 1) === 'AAE' && el(s, 2) === 'VGM') cur.vgmKg = Number(el(s, 3, 1));
    else if (s.tag === 'DOC' && ['SM1', 'SM2'].includes(el(s, 1) ?? '')) cur.method = el(s, 1) as 'SM1' | 'SM2';
    else if (s.tag === 'NAD' && el(s, 1) === 'SPC') cur.verifiedBy = el(s, 4) ?? el(s, 2);
    else if (s.tag === 'DTM' && el(s, 1) === '798') cur.verifiedAt = edifactToIso(el(s, 1, 1));
  }
  if (!out.length) throw new EdifactError('VERMAS contains no containers (EQD+CN)');
  const bad = out.find((e) => !(e.vgmKg > 0));
  if (bad) throw new EdifactError(`VERMAS has no valid VGM (MEA+AAE+VGM) for ${bad.unitRef}`);
  return out;
}

function edifactToIso(v?: string): string | undefined {
  const m = v && /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?$/.exec(v);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:00Z`;
}

interface HeaderInfo {
  sender: string;
  recipient: string;
  ref: string;
  at: Date;
}

function envelope(h: HeaderInfo, version: string[], body: (string | string[] | undefined)[][]): string {
  const dt = edifactDateTime(h.at);
  const unh = [['UNH', '1', version]];
  const segs = [...unh, ...body];
  return writeEdifact([
    ['UNB', ['UNOA', '2'], h.sender, h.recipient, [dt.date6, dt.time4], h.ref],
    ...segs,
    ['UNT', String(segs.length + 1), '1'],
    ['UNZ', '1', h.ref],
  ] as any);
}

export interface CoarriMove {
  unitRef: string;
  isoType: string | null;
  freightKind: string;
  grossWeightKg: string | null;
  completedAt: Date;
  moveKind: 'DISCHARGE' | 'LOAD';
  stowPosition?: string | null;
}

export function buildCoarri(
  h: HeaderInfo,
  visit: { voyage: string; imo: string; vesselName: string; lineOperator?: string; unlocode?: string | null },
  kind: 'DISCHARGE' | 'LOAD',
  moves: CoarriMove[],
): string {
  const body: (string | string[] | undefined)[][] = [
    ['BGM', kind === 'DISCHARGE' ? PROFILE.coarri.bgmDischarge : PROFILE.coarri.bgmLoad, h.ref, '9'],
    ['TDT', '20', visit.voyage, '1', '', [visit.lineOperator ?? '', '172', '20'], '', '', [visit.imo, '146', '', visit.vesselName]],
    ['RFF', ['VON', visit.voyage]],
  ];
  if (visit.unlocode) body.push(['LOC', kind === 'DISCHARGE' ? '11' : '9', [visit.unlocode, '139', '6']]);
  for (const m of moves) {
    body.push(['EQD', 'CN', m.unitRef, [m.isoType ?? '', '102', '5'], '', '', m.freightKind === 'MTY' ? '4' : '5']);
    if (m.stowPosition) body.push(['LOC', '147', [m.stowPosition, '', '5']]);
    body.push(['DTM', ['203', edifactDateTime(m.completedAt).ccyymmddhhmm, '203']]);
    if (m.grossWeightKg) body.push(['MEA', 'AAE', 'G', ['KGM', String(Number(m.grossWeightKg))]]);
  }
  body.push(['CNT', ['16', String(moves.length)]]);
  return envelope(h, PROFILE.coarri.version, body);
}

export function buildCodeco(
  h: HeaderInfo,
  gate: { direction: 'IN' | 'OUT'; unitRef: string; isoType: string | null; freightKind: string; truckPlate: string | null; at: Date; unlocode?: string | null },
): string {
  const body: (string | string[] | undefined)[][] = [
    ['BGM', gate.direction === 'IN' ? PROFILE.codeco.bgmGateIn : PROFILE.codeco.bgmGateOut, h.ref, '9'],
    ['EQD', 'CN', gate.unitRef, [gate.isoType ?? '', '102', '5'], '', '', gate.freightKind === 'MTY' ? '4' : '5'],
    ['DTM', ['7', edifactDateTime(gate.at).ccyymmddhhmm, '203']],
  ];
  if (gate.unlocode) body.push(['LOC', '165', [gate.unlocode, '139', '6']]);
  if (gate.truckPlate) body.push(['TDT', '1', '', '3', '', '', '', '', [gate.truckPlate, '146']]);
  body.push(['CNT', ['16', '1']]);
  return envelope(h, PROFILE.codeco.version, body);
}
