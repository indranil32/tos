#!/usr/bin/env node
// Loads realistic demo data into the demo tenant through the public API (synthetic data only).
// Env: BASE_URL, KC_URL, DEMO_PASSWORD. Skips if the terminal already has more than 3 visits (FORCE=1 to add anyway).
const BASE = process.env.BASE_URL?.replace(/\/$/, '');
const KC = process.env.KC_URL?.replace(/\/$/, '');
const PW = process.env.DEMO_PASSWORD;
const FAC = 'MPT1';
if (!BASE || !KC || !PW) { console.error('BASE_URL, KC_URL and DEMO_PASSWORD are required'); process.exit(2); }

async function token() {
  const r = await fetch(`${KC}/realms/demo/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'tos-cli', username: 'admin', password: PW }),
  });
  if (!r.ok) throw new Error(`token: ${r.status}`);
  return (await r.json()).access_token;
}
const TOKEN = await token();
async function call(method, path, body, ok = [200, 201]) {
  const headers = { Authorization: `Bearer ${TOKEN}`, 'X-Facility': FAC };
  let payload;
  if (typeof body === 'string') { headers['Content-Type'] = 'application/edifact'; payload = body; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  const text = await r.text();
  if (!ok.includes(r.status)) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const iso6346 = (prefix, serial) => {
  const first10 = `${prefix}${String(serial).padStart(6, '0')}`;
  const vals = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') { if (v % 11 === 0) v++; vals[ch] = v++; }
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (/[0-9]/.test(first10[i]) ? Number(first10[i]) : vals[first10[i]]) * 2 ** i;
  return first10 + ((sum % 11) % 10);
};
const daysAgo = (d, h = 9) => new Date(Date.now() - d * 86_400_000 - h * 3_600_000).toISOString();
const seed = Math.floor(Date.now() / 1000) % 900_000;
let n = 0;
const box = (prefix) => iso6346(prefix, (seed + n++ * 37) % 1_000_000);

// Terminal layout, equipment and work queues (idempotent: runs on every deploy, existing records are kept).
async function setupOperations() {
  const ok = [200, 201, 409];
  for (const b of [
    { code: 'B1', name: 'Berth 1', startMarkM: 0, lengthM: 350, depthM: 16, bollardFrom: '1', bollardTo: '18' },
    { code: 'B2', name: 'Berth 2', startMarkM: 350, lengthM: 300, depthM: 14, bollardFrom: '18', bollardTo: '33' },
    { code: 'RR1', name: 'RoRo ramp', berthKind: 'RORO_RAMP', startMarkM: 650, lengthM: 180, depthM: 11 },
    { code: 'J1', name: 'Liquid jetty', berthKind: 'LIQUID_JETTY', startMarkM: 830, lengthM: 120, depthM: 13 },
  ]) await call('POST', '/v1/terminal/berths', b, ok);
  for (const blk of [
    { code: 'A2', blockType: 'CONTAINER_STACK', bays: 20, rows: 6, tiers: 5, equipmentKind: 'RTG', allowedSizes: ['20', '40'] },
    { code: 'RF1', blockType: 'CONTAINER_STACK', bays: 10, rows: 4, tiers: 3, equipmentKind: 'RTG', reeferPlugs: 120 },
    { code: 'DG1', blockType: 'CONTAINER_STACK', bays: 6, rows: 4, tiers: 2, equipmentKind: 'RS', dgClasses: ['2.1', '3', '6.1', '8', '9'] },
    { code: 'T1', blockType: 'TANK', capacity: 25000 },
    { code: 'CFS1', blockType: 'WAREHOUSE', capacity: 1800 },
  ]) await call('POST', '/v1/yard-blocks', { facilityCode: FAC, yardCode: 'Y1', ...blk }, ok);
  await call('POST', '/v1/terminal/rail-tracks', { code: 'RT1', lengthM: 650, maxWagons: 30 }, ok);
  await call('POST', '/v1/terminal/rail-tracks', { code: 'RT2', lengthM: 650, maxWagons: 30 }, ok);
  for (const l of [
    { code: 'IN1', direction: 'IN', hasOcr: true }, { code: 'IN2', direction: 'IN', hasOcr: true },
    { code: 'OUT1', direction: 'OUT', hasOcr: true }, { code: 'TRB', direction: 'BOTH', laneKind: 'TROUBLE' },
  ]) await call('POST', '/v1/terminal/gate-lanes', l, ok);
  await call('POST', '/v1/facilities', { complexCode: 'KHL', code: 'ICD1', name: 'Inland container depot', currency: 'AED', timezone: 'Asia/Dubai', kinds: ['DRY_PORT', 'DEPOT', 'CFS'] }, ok);
  await call('POST', '/v1/terminal/links', { toFacility: 'ICD1', mode: 'RAIL', transitHours: 8 }, ok);

  await call('POST', '/v1/equipment-pools', { code: 'HK', name: 'Housekeeping' }, ok);
  await call('POST', '/v1/equipment-pools', { code: 'TT-B1', name: 'Trucks on berth 1' }, ok);
  const machines = [
    ['QC01', 'QC'], ['QC02', 'QC'], ['QC03', 'QC'], ['MHC1', 'MHC'],
    ['RTG01', 'RTG', 'HK'], ['RTG02', 'RTG', 'HK'], ['RTG03', 'RTG', 'HK'], ['RTG04', 'RTG'],
    ['RS01', 'RS'], ['ECH01', 'ECH'], ['FLT01', 'FLT'],
    ...Array.from({ length: 6 }, (_, i) => [`TT${String(i + 1).padStart(2, '0')}`, 'TT', 'TT-B1']),
  ];
  for (const [code, kind, pool] of machines) await call('POST', '/v1/equipment', { code, kind, pool, twinLift: kind === 'QC' }, ok);
  const eq = await call('GET', '/v1/equipment');
  const offline = new Set(eq.filter((e) => e.status === 'OFFLINE').map((e) => e.code));
  const ops = { QC01: 'Ravi', QC02: 'Omar', RTG01: 'Ali', RTG02: 'Sam', RS01: 'Joseph', TT01: 'Nadia', TT02: 'Hassan', TT03: 'Priya' };
  for (const [code, operator] of Object.entries(ops)) if (offline.has(code)) await call('POST', `/v1/equipment/${code}/status`, { status: 'IDLE', operator }, ok);
  if (offline.has('RTG03')) await call('POST', '/v1/equipment/RTG03/status', { status: 'BREAKDOWN', reason: 'Spreader fault' }, ok);
  if (offline.has('QC03')) await call('POST', '/v1/equipment/QC03/status', { status: 'MAINTENANCE', reason: 'Planned service' }, ok);

  await call('POST', '/v1/shifts', { code: 'DAY', name: 'Day shift', startsAt: '07:00', endsAt: '19:00' }, ok);
  await call('POST', '/v1/shifts', { code: 'NIGHT', name: 'Night shift', startsAt: '19:00', endsAt: '07:00' }, ok);
  await call('POST', '/v1/gangs', { code: 'G-A', name: 'Gang A', shift: 'DAY', members: ['Ravi', 'Omar', 'Nadia', 'Hassan'] }, ok);

  await call('POST', '/v1/work-queues', { code: 'HK-NIGHT', name: 'Night housekeeping', powKind: 'HOUSEKEEPING', pool: 'HK', priority: 80 }, ok);
  const q = await call('GET', '/v1/work-queues/HK-NIGHT');
  if (q.instructions.length === 0) {
    const inYard = (await call('GET', '/v1/units?state=IN_YARD')).filter((u) => u.cargoKind === 'CONTAINER').slice(0, 5);
    for (const u of inYard) await call('POST', '/v1/work-queues/HK-NIGHT/instructions', { moves: [{ unitRef: u.unitRef }] }, ok);
  }
  console.log('Terminal layout, equipment and queues ready.');
}

// Vessel planning showcase (idempotent): particulars, berth plan, an arrival BAPLIE, a stow plan and a crane split.
async function setupVesselPlanning() {
  const ok = [200, 201, 409, 422];
  const particulars = {
    '9321483': { loaM: 300, beamM: 48, maxDraftM: 14.5, maxBay: 39, maxRow: 16, holdTiers: 9, deckTiers: 6 },
    '9454412': { loaM: 280, beamM: 40, maxDraftM: 13.5, maxBay: 35, maxRow: 14, holdTiers: 8, deckTiers: 5 },
    '9702210': { loaM: 170, beamM: 32, maxDraftM: 9 },
    '9811000': { loaM: 260, beamM: 37, maxDraftM: 13, maxBay: 31, maxRow: 12, holdTiers: 7, deckTiers: 5 },
  };
  for (const [imo, p] of Object.entries(particulars)) await call('PUT', `/v1/vessels/${imo}`, p, ok);
  await call('POST', '/v1/vessels', { imo: '9811001', name: 'GULF MERIDIAN', vesselType: 'CONTAINER', loaM: 230, beamM: 32, maxDraftM: 12.5, maxBay: 23, maxRow: 8, holdTiers: 4, deckTiers: 3 }, ok);

  const hour = 3_600_000;
  const at = (h) => new Date(Math.round((Date.now() + h * hour) / hour) * hour).toISOString();
  let visit = (await call('GET', '/v1/visits')).find((v) => v.visitRef === 'GMR-PLAN');
  if (!visit) {
    visit = await call('POST', '/v1/visits', { visitRef: 'GMR-PLAN', imo: '9811001', lineOperator: 'MSC', voyageIn: 'GM01W', voyageOut: 'GM01E', eta: at(20) });
  }
  // Berth plan: the showcase on berth 1, other open visits where they fit.
  await call('PUT', `/v1/visits/${visit.id}/berth-plan`, { berth: 'B1', quayFromM: 20, eta: at(20), etb: at(22), etd: at(58) }, ok);
  const plan = await call('GET', '/v1/berth-plan');
  const starts = { B1: 20, B2: 350, RR1: 655 };
  for (const v of plan.visits.filter((x) => x.quayFromM === null && x.loaM && x.phase !== 'DEPARTED')) {
    const start = v.ata ? (Date.parse(v.ata) - Date.now()) / hour : v.eta ? (Date.parse(v.eta) - Date.now()) / hour : 72;
    // Try each berth, then a later window; the API refuses berths that are too short or too shallow, and clashes.
    placing: for (const shift of [0, 60, 120]) {
      for (const berth of v.vesselType === 'RORO' ? ['RR1', 'B2', 'B1'] : ['B2', 'B1']) {
        const etd = v.ata ? Math.max(start + 40, 10) : start + 40 + shift; // a vessel alongside leaves in the future
        const r = await call('PUT', `/v1/visits/${v.id}/berth-plan`, { berth, quayFromM: starts[berth], etb: at(start + 1 + (v.ata ? 0 : shift)), etd: at(etd) }, ok);
        if (!r?.title) break placing;
      }
    }
  }

  const bp = await call('GET', `/v1/visits/${visit.id}/bay-plan`);
  if (bp.cells.length === 0) {
    // Arrival stowage: deterministic pseudo-random fill of 6 hatches.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const cells = [];
    let serial = 810000;
    for (let h = 0; h < 6; h++) {
      const forty = h % 2 === 0;
      const bays = forty ? [4 * h + 2] : [4 * h + 1, 4 * h + 3];
      for (const bay of bays) for (const row of [1, 2, 3, 4, 5, 6, 7, 8]) {
        // Each stack: cargo for later ports at the bottom, this port's cargo on top (as a line would stow it).
        // Hold discharges only in the two aft hatches, so a few deck stacks there become hatch-cover restows.
        for (const [tiers, deck] of [[[2, 4, 6, 8], false], [[82, 84, 86], true]]) {
          const height = Math.floor(rnd() * (tiers.length + 1));
          const forPort = deck ? Math.floor(rnd() * (height + 1)) : h >= 4 ? Math.floor(rnd() * 2) : 0;
          for (let i = 0; i < height; i++) {
            const tier = tiers[i];
            const pod = i >= height - forPort ? 'AEKHL' : rnd() < 0.5 ? 'SGSIN' : 'INNSA';
            cells.push({ cell: `${String(bay).padStart(3, '0')}${String(row).padStart(2, '0')}${String(tier).padStart(2, '0')}`,
              unit: iso6346(forty ? 'MSDU' : 'MSKU', serial++), iso: forty ? '45G1' : '22G1', pod,
              kg: Math.round(9000 + rnd() * 21000), dg: rnd() < 0.04, reefer: deck && rnd() < 0.08 });
          }
        }
      }
    }
    const body = [
      'UNH+1+BAPLIE:D:95B:UN:SMDG22', 'BGM++GMR001+9', 'TDT+20+GM01W+++MSC:172:20+++9811001:146::GULF MERIDIAN', 'LOC+5+CNSHA:139:6',
      ...cells.flatMap((c) => [`LOC+147+${c.cell}::5`, `MEA+WT++KGM:${c.kg}`, ...(c.reefer ? ['TMP+2+-18:CEL'] : []), 'LOC+9+CNSHA:139:6',
        `LOC+11+${c.pod}:139:6`, `EQD+CN+${c.unit}+${c.iso}+++5`, 'NAD+CA+MSC:172:20', ...(c.dg ? ['DGS+IMD+3+1263'] : [])]),
    ];
    await call('POST', '/v1/edi/inbound', ['UNB+UNOA:2+MSC+KHLMPT+261119:0600+GMR001', ...body, `UNT+${body.length + 1}+1`, 'UNZ+1+GMR001'].map((s) => s + "'").join(''));

    // Exports for this call, stowed into cells freed by the discharge and empty slots.
    const after = await call('GET', `/v1/visits/${visit.id}/bay-plan`);
    const used = new Set(after.cells.filter((c) => c.state !== 'DISCHARGE').map((c) => `${c.bay}-${c.row}-${c.tier}`));
    const exportsGm = Array.from({ length: 18 }, (_, i) => ({ move: 'LOAD', unitRef: iso6346('GMXU', 820000 + i), isoType: '22G1', grossWeightKg: 12000 + i * 600, lineOperator: 'MSC', pol: 'AEKHL', pod: i % 3 ? 'SGSIN' : 'INNSA' }));
    await call('POST', `/v1/visits/${visit.id}/load-lists`, { items: exportsGm });
    const free = [];
    for (const bay of [3, 7, 11, 15, 19, 23]) for (const row of [1, 2, 3, 4, 5, 6, 7, 8]) for (const tier of [82, 84]) {
      const k = (b) => `${b}-${row}-${tier}`;
      const below = tier === 82 || used.has(k(bay)) || free.includes(`${bay}-${row}-${tier - 2}`);
      const forty = [bay - 1, bay + 1].some((b) => used.has(k(b)));
      if (!used.has(k(bay)) && !forty && below) free.push(`${bay}-${row}-${tier}`);
    }
    const assignments = exportsGm.slice(0, 14).map((e, i) => {
      const [bay, row, tier] = free[i * 3 % free.length].split('-').map(Number);
      return { unitRef: e.unitRef, cell: `${String(bay).padStart(3, '0')}${String(row).padStart(2, '0')}${String(tier).padStart(2, '0')}` };
    });
    const unique = [...new Map(assignments.map((a) => [a.cell, a])).values()];
    await call('PUT', `/v1/visits/${visit.id}/stow-plan`, { assignments: unique }, ok);
    // Leave four loads unstowed so the planner has something to place; split the rest only when all have cells.
    console.log(`Vessel planning showcase: ${cells.length} cells on board, ${unique.length} loads stowed.`);
  }
  // Yard strategy: reserved bays for this call's exports and for MSC empties (overlaps are refused, so this is idempotent).
  await call('POST', '/v1/yard/ranges', { name: 'GMR-PLAN exports', block: 'A2', bayFrom: 1, bayTo: 6, purpose: 'EXPORT', visitId: visit.id, priority: 10 }, ok);
  await call('POST', '/v1/yard/ranges', { name: 'MSC empties', block: 'A2', bayFrom: 15, bayTo: 20, purpose: 'EMPTY', line: 'MSC', priority: 40 }, ok);
  const split = await call('GET', `/v1/visits/${visit.id}/crane-split`);
  if (!split.queues.length) {
    const r = await call('POST', `/v1/visits/${visit.id}/crane-split`, { cranes: ['QC01', 'QC02'], movesPerHour: 28 }, ok);
    if (r?.title) console.log(`Crane split not run yet: ${r.detail}`);
  }
}

const visits0 = await call('GET', '/v1/visits');
if (visits0.length > 3 && !process.env.FORCE) { await setupOperations(); await setupVesselPlanning(); }

const visits = await call('GET', '/v1/visits');
if (visits.length > 3 && !process.env.FORCE) { console.log(`Demo data already present (${visits.length} visits); set FORCE=1 to add more.`); process.exit(0); }

const o = { ok: [201, 409] };
for (const p of [['CMA', 'CMA CGM'], ['HLC', 'Hapag-Lloyd'], ['MSK', 'Maersk']]) {
  await call('POST', '/v1/partners', { code: p[0], name: p[1], roles: ['LINE_OPERATOR', 'CUSTOMER'] }, o.ok);
}
for (const [imo, name, type] of [['9321483', 'MSC AURORA', 'CONTAINER'], ['9454412', 'CMA CGM ORION', 'CONTAINER'], ['9702210', 'HOEGH TRACER', 'RORO'], ['9811000', 'HAPAG STAR', 'CONTAINER']]) {
  await call('POST', '/v1/vessels', { imo, name, vesselType: type }, o.ok);
}
const validFrom = '2026-01-01';
const tariffs = await call('GET', '/v1/tariffs');
const have = new Set(tariffs.map((t) => `${t.chargeCode}/${t.cargoKind}`));
for (const t of [
  { chargeCode: 'LOAD', description: 'Container load', cargoKind: 'CONTAINER', triggerEvent: 'unit.loaded', basis: 'PER_TEU', rate: 50, currency: 'AED' },
  { chargeCode: 'BB-DISCH', description: 'Break-bulk discharge', cargoKind: 'BREAKBULK', triggerEvent: 'unit.discharged', basis: 'PER_TONNE', rate: 12, currency: 'AED' },
  { chargeCode: 'RORO-DISCH', description: 'Vehicle discharge', cargoKind: 'VEHICLE', triggerEvent: 'unit.discharged', basis: 'PER_UNIT', rate: 85, currency: 'AED' },
  { chargeCode: 'RORO-STOR', description: 'Vehicle storage', cargoKind: 'VEHICLE', triggerEvent: 'storage', basis: 'PER_DAY', rate: 15, currency: 'AED', freeDays: 5 },
]) if (!have.has(`${t.chargeCode}/${t.cargoKind}`)) await call('POST', '/v1/tariffs', { ...t, validFrom });

const tag = Date.now().toString(36).slice(-4).toUpperCase();
// 1. A container vessel that arrived a few days ago: imports, transshipments, DG and reefers, back-dated discharges.
const v1 = await call('POST', '/v1/visits', { visitRef: `MSC-${tag}`, imo: '9321483', lineOperator: 'MSC', voyageIn: `${tag}E`, voyageOut: `${tag}W`, berth: 'B2', eta: daysAgo(17, 0) });
const imports = [];
const lines = ['MSC', 'MSC', 'MSC', 'CMA', 'HLC', 'MSK'];
for (let i = 0; i < 18; i++) {
  const line = lines[i % lines.length];
  imports.push({
    unitRef: box(line === 'MSC' ? 'MSCU' : line === 'CMA' ? 'CMAU' : line === 'HLC' ? 'HLXU' : 'MSKU'),
    isoType: i % 3 === 0 ? '45G1' : i % 5 === 0 ? '42R1' : '22G1', grossWeightKg: 14000 + i * 650, lineOperator: line, pol: 'CNSHA', pod: 'AEKHL',
    category: i % 6 === 5 ? 'TRANSSHIP' : 'IMPORT', isReefer: i % 5 === 0, ...(i % 7 === 3 ? { dgClass: i % 2 ? '3' : '8', dgUnNumber: i % 2 ? '1203' : '1789' } : {}),
  });
}
await call('POST', `/v1/visits/${v1.id}/load-lists`, { items: imports });
await call('POST', `/v1/visits/${v1.id}/arrive`, { ata: daysAgo(17, 0), berth: 'B2' });
const dwell = [16, 16, 12, 12, 9, 9, 6, 6, 4, 4, 2, 2, 1, 1, 0, 0];
for (let i = 0; i < 16; i++) await call('POST', `/v1/visits/${v1.id}/discharges`, { unitRef: imports[i].unitRef, cheId: `QC0${(i % 3) + 1}`, completedAt: daysAgo(dwell[i]) });
// holds
const u = await call('GET', '/v1/units');
const byRef = Object.fromEntries(u.map((x) => [x.unitRef, x]));
for (const [i, type, ref] of [[2, 'CUSTOMS', 'ASY-2026-118204'], [7, 'CUSTOMS', 'ASY-2026-118377'], [9, 'INSPECTION', 'RISK-554'], [4, 'LINE', 'FREIGHT UNPAID']]) {
  await call('POST', `/v1/units/${byRef[imports[i].unitRef].id}/holds`, { holdType: type, reference: ref });
}
// gate-outs: two delivered, one refused because of the customs hold
for (const i of [0, 1]) await call('POST', '/v1/gate/transactions', { direction: 'OUT', unitRef: imports[i].unitRef, truckPlate: `AD ${31000 + i}` });
await call('POST', '/v1/gate/transactions', { direction: 'OUT', unitRef: imports[2].unitRef, truckPlate: 'AD 31977' });

// 2. Break-bulk and vehicles on a RoRo call
const v2 = await call('POST', '/v1/visits', { visitRef: `HOE-${tag}`, imo: '9702210', lineOperator: 'MSK', voyageIn: `R${tag}`, berth: 'B5', eta: daysAgo(6, 0) });
const vins = ['WVWZZZ1JZ3W386752', 'JTDKN3DU5A0123456', 'SALLAAAA1AA123456', 'WDB9634031L738261', 'VF1RFB00X56543210'];
await call('POST', `/v1/visits/${v2.id}/load-lists`, { items: [
  ...vins.map((vin) => ({ unitRef: vin, cargoKind: 'VEHICLE', freightKind: 'NA', pod: 'AEKHL', lineOperator: 'MSK' })),
  { unitRef: `LOT-STEEL-${tag}`, cargoKind: 'BREAKBULK', freightKind: 'NA', quantity: 42, quantityUom: 'MT', pod: 'AEKHL', lineOperator: 'MSK' },
] });
await call('POST', `/v1/visits/${v2.id}/arrive`, { ata: daysAgo(6, 0), berth: 'B5' });
for (const [i, vin] of vins.entries()) await call('POST', `/v1/visits/${v2.id}/discharges`, { unitRef: vin, completedAt: daysAgo(5 - (i % 3)) });
await call('POST', `/v1/visits/${v2.id}/discharges`, { unitRef: `LOT-STEEL-${tag}`, completedAt: daysAgo(4) });
await call('POST', `/v1/visits/${v2.id}/depart`, {});

// 3. The next mainliner: export pre-advice, gate-ins with and without VGM, a VERMAS from a shipper
const v3 = await call('POST', '/v1/visits', { visitRef: `HAP-${tag}`, imo: '9811000', lineOperator: 'HLC', voyageIn: `H${tag}E`, voyageOut: `H${tag}W`, berth: 'B1', eta: new Date(Date.now() + 2 * 86_400_000).toISOString() });
const exportsList = Array.from({ length: 8 }, (_, i) => ({
  move: 'LOAD', unitRef: box('HLXU'), isoType: i % 2 ? '45G1' : '22G1', grossWeightKg: 17000 + i * 900, lineOperator: 'HLC',
  pol: 'AEKHL', pod: i % 2 ? 'DEHAM' : 'NLRTM', ...(i === 6 ? { freightKind: 'MTY', grossWeightKg: 3900 } : {}), ...(i === 5 ? { isReefer: true } : {}),
}));
exportsList.push({ move: 'LOAD', unitRef: imports[5].unitRef, isoType: imports[5].isoType, pod: 'INNSA' }); // transshipment onward
await call('POST', `/v1/visits/${v3.id}/load-lists`, { items: exportsList });
for (const [i, e] of exportsList.slice(0, 7).entries()) {
  await call('POST', '/v1/gate/transactions', { direction: 'IN', unitRef: e.unitRef, truckPlate: `AD ${42000 + i}`, at: daysAgo(3 - (i % 3)), ...(i < 3 ? { vgm: { vgmKg: e.grossWeightKg + 250, method: 'SM1', verifiedBy: 'Shipper LLC' } } : {}) });
}
const vermas = ['UNH+1+VERMAS:D:16A:UN:SMDG10', `BGM+XXX+VG${tag}+9`, `EQD+CN+${exportsList[3].unitRef}+45G1:6346:5`, `MEA+AAE+VGM+KGM:${exportsList[3].grossWeightKg + 410}`, 'DOC+SM2', 'NAD+SPC+++Gulf Exporters LLC'];
await call('POST', '/v1/edi/inbound', ['UNB+UNOA:2+GULFEXP+KHLMPT+261119:0800+' + tag, ...vermas, `UNT+${vermas.length + 1}+1`, `UNZ+1+${tag}`].map((s) => s + "'").join(''));
await call('POST', '/v1/edi/inbound', `UNB+UNOA:2+MSC+KHLMPT+261119:0810+X${tag}'UNH+1+COPRAR:D:00B:UN:SMDG21'BGM+45+X+9'TDT+20+NOSUCH+1'UNT+4+1'UNZ+1+X${tag}'`, [201, 404, 422]);
// COARRI for the first vessel
await fetch(`${BASE}/v1/edi/outbound/coarri/${v1.id}`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Facility': FAC } });

// invoices for MSC; leave other lines' charges open
await call('POST', '/v1/invoices', { customer: 'MSC' }, [201, 409]);
console.log(`Demo data loaded: visits MSC-${tag}, HOE-${tag}, HAP-${tag}`);

await setupOperations();
await setupVesselPlanning();
