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
