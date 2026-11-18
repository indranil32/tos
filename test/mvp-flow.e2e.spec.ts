import { INestApplication } from '@nestjs/common';
import { container, createApp, expectOk, provisionTenant } from './support/harness';

/**
 * MVP slice: one vessel call, discharge to invoice, on a multipurpose terminal
 * (two containers and one break-bulk lot), with a customs hold at the gate.
 */
describe('Vessel call: discharge to invoice', () => {
  let app: INestApplication;
  let t: Awaited<ReturnType<typeof provisionTenant>>;
  const c1 = container('MSCU', 100001);
  const c2 = container('MSCU', 100002);
  const lot = 'LOT-STEEL-0001';
  let visitId: string;

  beforeAll(async () => {
    app = await createApp();
    t = await provisionTenant(app);
  });
  afterAll(async () => app.close());

  it('sets up tariffs, including a customer contract rate that beats the standard rate', async () => {
    const billing = await t.as(['tos:billing']);
    const tariffs = [
      { chargeCode: 'DISCH', description: 'Container discharge', cargoKind: 'CONTAINER', triggerEvent: 'unit.discharged', basis: 'PER_TEU', rate: 50, currency: 'AED' },
      { chargeCode: 'DISCH', description: 'Container discharge (MSC contract)', cargoKind: 'CONTAINER', triggerEvent: 'unit.discharged', basis: 'PER_TEU', rate: 40, currency: 'AED', customer: 'MSC' },
      { chargeCode: 'STOR', description: 'Import storage', cargoKind: 'CONTAINER', triggerEvent: 'storage', basis: 'PER_DAY', rate: 10, currency: 'AED', freeDays: 3 },
      { chargeCode: 'LIFT', description: 'Lift on to truck', cargoKind: 'CONTAINER', triggerEvent: 'unit.gated-out', basis: 'PER_UNIT', rate: 20, currency: 'AED' },
      { chargeCode: 'BB-DISCH', description: 'Break-bulk discharge', cargoKind: 'BREAKBULK', triggerEvent: 'unit.discharged', basis: 'PER_TONNE', rate: 12, currency: 'AED', allFacilities: true },
    ];
    // Tariffs apply by event date: back-dated moves need a tariff that was already valid then.
    const validFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    for (const tr of tariffs) await expectOk(billing.post('/v1/tariffs', { ...tr, validFrom }));
    const list = await billing.get('/v1/tariffs');
    expect(list.body).toHaveLength(5);
  });

  it('creates the vessel and visit', async () => {
    const planner = await t.as(['tos:planner']);
    await expectOk(planner.post('/v1/vessels', { imo: '9321483', name: 'MSC AURORA', callSign: '3EAB7', vesselType: 'GENERAL_CARGO' }));
    const v = await expectOk(planner.post('/v1/visits', { visitRef: 'AUR-001', imo: '9321483', lineOperator: 'MSC', voyageIn: '001E', voyageOut: '001W' }));
    visitId = v.body.id;
    expect(v.body.phase).toBe('PLANNED');
  });

  it('rejects a load list with an invalid ISO 6346 container number', async () => {
    const planner = await t.as(['tos:planner']);
    const r = await planner.post(`/v1/visits/${visitId}/load-lists`, { items: [{ unitRef: 'MSCU1000010', isoType: '22G1' }] });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].message).toMatch(/ISO 6346/);
  });

  it('accepts the discharge list (containers and a break-bulk lot); re-sending is idempotent', async () => {
    const planner = await t.as(['tos:planner']);
    const items = [
      { unitRef: c1, isoType: '22G1', grossWeightKg: 21000, pol: 'CNSHA', pod: 'AEKHL' },
      { unitRef: c2, isoType: '45G1', grossWeightKg: 28000, pol: 'CNSHA', pod: 'AEKHL', dgClass: '3', dgUnNumber: '1203' },
      { unitRef: lot, cargoKind: 'BREAKBULK', freightKind: 'NA', quantity: 25, quantityUom: 'MT', pod: 'AEKHL' },
    ];
    const r = await expectOk(planner.post(`/v1/visits/${visitId}/load-lists`, { items }));
    expect(r.body).toMatchObject({ created: 3, updated: 0 });
    const again = await expectOk(planner.post(`/v1/visits/${visitId}/load-lists`, { items }));
    expect(again.body).toMatchObject({ created: 0, updated: 3 });
    const visit = await planner.get(`/v1/visits/${visitId}`);
    expect(visit.body.plannedMoves).toBe(3);
  });

  it('refuses discharge before the vessel has arrived', async () => {
    const op = await t.as(['tos:operator']);
    const r = await op.post(`/v1/visits/${visitId}/discharges`, { unitRef: c1 });
    expect(r.status).toBe(409);
  });

  const now = new Date();
  const sixDaysAgo = new Date(now.getTime() - 6 * 86_400_000);

  it('discharges into the yard with automatic slot allocation', async () => {
    const op = await t.as(['tos:operator']);
    await expectOk(op.post(`/v1/visits/${visitId}/arrive`, { berth: 'B3' }));
    const d1 = await expectOk(op.post(`/v1/visits/${visitId}/discharges`, { unitRef: c1, cheId: 'QC01', completedAt: sixDaysAgo.toISOString() }));
    const d2 = await expectOk(op.post(`/v1/visits/${visitId}/discharges`, { unitRef: c2, cheId: 'QC01' }));
    const d3 = await expectOk(op.post(`/v1/visits/${visitId}/discharges`, { unitRef: lot }));
    expect(d1.body.position).toBe('A1-01-01-1');
    expect(d2.body.position).toBe('A1-01-01-2');
    expect(d3.body.position).toBe('L1-0001');

    const dup = await op.post(`/v1/visits/${visitId}/discharges`, { unitRef: c1 });
    expect(dup.status).toBe(409);

    const moves = await op.get(`/v1/visits/${visitId}/moves`);
    expect(moves.body.filter((m: any) => m.status === 'COMPLETED')).toHaveLength(3);
    const visit = await op.get(`/v1/visits/${visitId}`);
    expect(visit.body.phase).toBe('WORKING');
  });

  it('blocks gate-out while a customs hold is active, then releases', async () => {
    const op = await t.as(['tos:operator']);
    const gate = await t.as(['tos:gate']);
    const unit = (await op.get(`/v1/units?ref=${c1}`)).body[0];
    expect(unit.state).toBe('IN_YARD');

    const hold = await expectOk(op.post(`/v1/units/${unit.id}/holds`, { holdType: 'CUSTOMS', reference: 'ASY-2026-000123' }));
    const rejected = await expectOk(gate.post('/v1/gate/transactions', { direction: 'OUT', unitRef: c1, truckPlate: 'AD-12345' }));
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.rejectReason).toMatch(/CUSTOMS/);

    await expectOk(op.post(`/v1/units/${unit.id}/holds/${hold.body.id}/release`));
    const ok = await expectOk(gate.post('/v1/gate/transactions', { direction: 'OUT', unitRef: c1, truckPlate: 'AD-12345', at: now.toISOString() }));
    expect(ok.body.status).toBe('COMPLETED');

    const after = (await op.get(`/v1/units/${unit.id}`)).body;
    expect(after.state).toBe('DEPARTED');
    expect(after.holds).toHaveLength(1);
    expect(after.holds[0].releasedAt).toBeTruthy();
  });

  it('invoices the line: contract discharge rate, storage after free days (calendar days), lift-on, break-bulk per tonne', async () => {
    const billing = await t.as(['tos:billing']);
    const r = await expectOk(billing.post('/v1/invoices', { customer: 'MSC' }));
    expect(r.body.invoices).toHaveLength(1);
    const inv = r.body.invoices[0];
    expect(inv.currency).toBe('AED');
    expect(inv.invoiceNo).toMatch(/^MPT1-\d{4}-000001$/);

    const byKey = Object.fromEntries(inv.lines.map((l: any) => [`${l.unitRef}/${l.chargeCode}`, Number(l.amount)]));
    expect(byKey).toEqual({
      [`${c1}/DISCH`]: 40, // 1 TEU x 40 (contract)
      [`${c1}/LIFT`]: 20,
      [`${c1}/STOR`]: 40, // 7 calendar days (arrival day counts) - 3 free = 4 x 10
      [`${c2}/DISCH`]: 80, // 2 TEU x 40
      [`${lot}/BB-DISCH`]: 300, // 25 t x 12
    });
    expect(Number(inv.total)).toBe(480);

    const second = await billing.post('/v1/invoices', { customer: 'MSC' });
    expect(second.status).toBe(409);
  });

  it('publishes every step on the event feed', async () => {
    const op = await t.as(['tos:viewer']);
    const r = await expectOk(op.get('/v1/events'));
    const types = r.body.events.map((e: any) => e.type);
    for (const t of ['vessel-call.updated', 'loadlist.updated', 'vessel.arrived', 'unit.discharged', 'hold.applied', 'hold.released', 'unit.gated-out', 'invoice.issued']) {
      expect(types).toContain(t);
    }
    expect(types.filter((x: string) => x === 'unit.discharged')).toHaveLength(3);
  });

  it('lets a departed container number be advised again on a later call', async () => {
    const planner = await t.as(['tos:planner']);
    const v2 = await expectOk(planner.post('/v1/visits', { visitRef: 'AUR-002', imo: '9321483', lineOperator: 'MSC', voyageIn: '002E' }));
    const r = await expectOk(planner.post(`/v1/visits/${v2.body.id}/load-lists`, { items: [{ unitRef: c1, isoType: '22G1' }] }));
    expect(r.body.created).toBe(1);
  });
});
