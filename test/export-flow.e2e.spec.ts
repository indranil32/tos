import { INestApplication } from '@nestjs/common';
import { el, parseEdifact } from '../src/edi/edifact';
import { container, createApp, expectOk, provisionTenant } from './support/harness';

/**
 * Export side of a vessel call: pre-advice, gate-in, SOLAS VGM (API, gate and VERMAS),
 * load confirmation with stow cell, COARRI load report, departure; plus a transshipment.
 */
describe('Vessel call: gate-in to load and departure', () => {
  let app: INestApplication;
  let t: Awaited<ReturnType<typeof provisionTenant>>;
  let inbound: string;
  let outbound: string;
  const full = container('HLXU', 300001);
  const viaVermas = container('HLXU', 300002);
  const empty = container('HLXU', 300003);
  const atGate = container('HLXU', 300004);
  const tship = container('HLXU', 300005);

  beforeAll(async () => {
    app = await createApp();
    t = await provisionTenant(app);
    const planner = await t.as(['tos:planner']);
    const billing = await t.as(['tos:billing']);
    await expectOk(planner.post('/v1/vessels', { imo: '9600001', name: 'HAPAG STAR' }));
    await expectOk(planner.post('/v1/vessels', { imo: '9600002', name: 'FEEDER ONE' }));
    inbound = (await expectOk(planner.post('/v1/visits', { visitRef: 'FDR-01', imo: '9600002', lineOperator: 'MSC', voyageIn: 'F01' }))).body.id;
    outbound = (await expectOk(planner.post('/v1/visits', { visitRef: 'HAP-01', imo: '9600001', lineOperator: 'MSC', voyageIn: 'H01E', voyageOut: 'H01W' }))).body.id;
    const validFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await expectOk(billing.post('/v1/tariffs', { chargeCode: 'LOAD', description: 'Container load', cargoKind: 'CONTAINER', triggerEvent: 'unit.loaded', basis: 'PER_UNIT', rate: 45, currency: 'AED', validFrom }));
    await expectOk(billing.post('/v1/tariffs', { chargeCode: 'STOR', description: 'Storage', cargoKind: 'CONTAINER', triggerEvent: 'storage', basis: 'PER_DAY', rate: 10, currency: 'AED', freeDays: 3, validFrom }));
  });
  afterAll(async () => app.close());

  it('takes export pre-advice through the load list (COPRAR loading twin)', async () => {
    const planner = await t.as(['tos:planner']);
    const items = [full, viaVermas, atGate].map((unitRef) => ({ move: 'LOAD', unitRef, isoType: '22G1', grossWeightKg: 18000, pol: 'AEKHL', pod: 'DEHAM' }));
    items.push({ move: 'LOAD', unitRef: empty, isoType: '42G1', grossWeightKg: 3800, pol: 'AEKHL', pod: 'DEHAM', freightKind: 'MTY' } as any);
    const r = await expectOk(planner.post(`/v1/visits/${outbound}/load-lists`, { items }));
    expect(r.body).toMatchObject({ created: 4 });
  });

  it('gates the boxes in; VGM can be declared at the gate', async () => {
    const gate = await t.as(['tos:gate']);
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    for (const unitRef of [full, viaVermas, empty]) {
      const r = await expectOk(gate.post('/v1/gate/transactions', { direction: 'IN', unitRef, truckPlate: 'AD-1', at: tenDaysAgo }));
      expect(r.body.status).toBe('COMPLETED');
      expect(r.body.position).toMatch(/^A1-/);
    }
    const r = await expectOk(gate.post('/v1/gate/transactions', { direction: 'IN', unitRef: atGate, vgm: { vgmKg: 18250, method: 'SM1', verifiedBy: 'Shipper LLC' } }));
    expect(r.body.status).toBe('COMPLETED');
    const unknown = await expectOk(gate.post('/v1/gate/transactions', { direction: 'IN', unitRef: container('HLXU', 399999) }));
    expect(unknown.body).toMatchObject({ status: 'REJECTED', rejectReason: expect.stringMatching(/pre-advice/) });
  });

  it('blocks loading a packed container without VGM (SOLAS VI/2), but not an empty', async () => {
    const op = await t.as(['tos:operator']);
    await expectOk(op.post(`/v1/visits/${outbound}/arrive`, { berth: 'B1' }));
    const blocked = await op.post(`/v1/visits/${outbound}/loads`, { unitRef: full, stowPosition: '0120682' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.title).toBe('vgm_missing');
    await expectOk(op.post(`/v1/visits/${outbound}/loads`, { unitRef: empty, stowPosition: '0140084' }));
  });

  it('records VGM by API and by VERMAS, then loads', async () => {
    const op = await t.as(['tos:operator']);
    const unit = (await op.get(`/v1/units?ref=${full}`)).body[0];
    await expectOk(op.put(`/v1/units/${unit.id}/vgm`, { vgmKg: 18320, method: 'SM2', verifiedBy: 'Forwarder Co' }));

    const edi = await t.as(['tos:edi']);
    const body = ['UNH+1+VERMAS:D:16A:UN:SMDG10', 'BGM+XXX+VGM0001+9', `EQD+CN+${viaVermas}+22G1:6346:5`, 'MEA+AAE+VGM+KGM:19100', 'DTM+798:202611180930:203', 'DOC+SM1', 'NAD+SPC+++Exporter Trading LLC'];
    const vermas = ['UNB+UNOA:2+SHIPPER+KHLMPT+261118:0930+VG1', ...body, `UNT+${body.length + 1}+1`, 'UNZ+1+VG1'].map((s) => s + "'").join('');
    const r = await expectOk(edi.postText('/v1/edi/inbound', vermas));
    expect(r.body).toMatchObject({ status: 'ACCEPTED', messageType: 'VERMAS', result: { vgmRecorded: 1 } });
    const v = (await op.get(`/v1/units?ref=${viaVermas}`)).body[0];
    expect(Number(v.vgmKg)).toBe(19100);
    expect(v.vgmMethod).toBe('SM1');

    for (const [unitRef, cell] of [[full, '0120682'], [viaVermas, '0120684'], [atGate, '0120686']]) {
      const l = await expectOk(op.post(`/v1/visits/${outbound}/loads`, { unitRef, stowPosition: cell, cheId: 'QC02' }));
      expect(l.body.stowPosition).toBe(cell);
    }
    const again = await op.post(`/v1/visits/${outbound}/loads`, { unitRef: full });
    expect(again.status).toBe(409);
  });

  it('handles a transshipment: discharge from the feeder, block gate-out, load on the mainliner', async () => {
    const planner = await t.as(['tos:planner']);
    const op = await t.as(['tos:operator']);
    const gate = await t.as(['tos:gate']);
    await expectOk(planner.post(`/v1/visits/${inbound}/load-lists`, { items: [{ unitRef: tship, isoType: '22G1', category: 'TRANSSHIP', pol: 'OMSOH', pod: 'DEHAM' }] }));
    await expectOk(op.post(`/v1/visits/${inbound}/arrive`, {}));
    await expectOk(op.post(`/v1/visits/${inbound}/discharges`, { unitRef: tship }));
    const out = await expectOk(gate.post('/v1/gate/transactions', { direction: 'OUT', unitRef: tship }));
    expect(out.body.status).toBe('REJECTED');
    await expectOk(planner.post(`/v1/visits/${outbound}/load-lists`, { items: [{ move: 'LOAD', unitRef: tship, isoType: '22G1', pod: 'DEHAM' }] }));
    const unit = (await op.get(`/v1/units?ref=${tship}`)).body[0];
    await expectOk(op.put(`/v1/units/${unit.id}/vgm`, { vgmKg: 20000 }));
    await expectOk(op.post(`/v1/visits/${outbound}/loads`, { unitRef: tship, stowPosition: '0220482' }));
  });

  it('produces the COARRI load report with stow cells', async () => {
    const edi = await t.as(['tos:edi']);
    const r = await expectOk(edi.get(`/v1/edi/outbound/coarri/${outbound}?kind=LOAD`));
    const segs = parseEdifact(r.text);
    expect(el(segs.find((s) => s.tag === 'BGM'), 1)).toBe('46');
    expect(el(segs.find((s) => s.tag === 'TDT'), 2)).toBe('H01W');
    expect(segs.filter((s) => s.tag === 'EQD')).toHaveLength(5);
    expect(segs.filter((s) => s.tag === 'LOC' && el(s, 1) === '147').map((s) => el(s, 2))).toContain('0120682');
  });

  it('bills load and export storage (gated in 10 days ago, 3 free days)', async () => {
    const billing = await t.as(['tos:billing']);
    const charges = (await expectOk(billing.get(`/v1/charges?customer=MSC&uninvoiced=true`))).body;
    const of = (ref: string, code: string) => charges.filter((c: any) => c.unitRef === ref && c.chargeCode === code).map((c: any) => Number(c.amount));
    expect(of(full, 'LOAD')).toEqual([45]);
    expect(of(full, 'STOR')).toEqual([80]); // 11 calendar days (both ends count) - 3 free = 8 x 10
    expect(of(atGate, 'STOR')).toEqual([]); // same-day: within free days
  });

  it('departs: loaded units leave the terminal and their numbers are free again', async () => {
    const op = await t.as(['tos:operator']);
    const d = await expectOk(op.post(`/v1/visits/${outbound}/depart`, {}));
    expect(d.body).toMatchObject({ phase: 'DEPARTED', unitsDeparted: 5 });
    const u = (await op.get(`/v1/units?ref=${full}`)).body[0];
    expect(u.state).toBe('DEPARTED');
    expect(u.stowPosition).toBe('0120682');
    const late = await op.post(`/v1/visits/${outbound}/loads`, { unitRef: full });
    expect(late.status).toBe(409);
  });
});
