import { INestApplication } from '@nestjs/common';
import { container, createApp, expectOk, provisionTenant } from './support/harness';

/** Phase 1 yard strategy: ranges per vessel and POD, block rules for reefers, DG and sizes, explicit slot checks. */
describe('Yard strategy', () => {
  let app: INestApplication;
  let t: Awaited<ReturnType<typeof provisionTenant>>;
  let visitId: string;
  const X = Array.from({ length: 6 }, (_, i) => container('YRDU', 600001 + i));

  beforeAll(async () => {
    app = await createApp();
    t = await provisionTenant(app);
    const admin = t.admin;
    for (const b of [
      { code: 'EX', bays: 4, rows: 2, tiers: 3, allowedSizes: ['20', '40'], maxStackKg: 70000 },
      { code: 'RF', bays: 2, rows: 1, tiers: 2, reeferPlugs: 1 },
      { code: 'DG', bays: 2, rows: 1, tiers: 1, dgClasses: ['3'] },
    ]) await expectOk(admin.post('/v1/yard-blocks', { facilityCode: t.facility, yardCode: 'Y1', blockType: 'CONTAINER_STACK', ...b }));
    const bad = await admin.post('/v1/yard-blocks', { facilityCode: t.facility, yardCode: 'Y1', code: 'X-1', blockType: 'CONTAINER_STACK' });
    expect(bad.status).toBe(422);

    const planner = await t.as(['tos:planner']);
    await expectOk(planner.post('/v1/vessels', { imo: '9500001', name: 'YARD STAR' }));
    visitId = (await expectOk(planner.post('/v1/visits', { visitRef: 'YRD-01', imo: '9500001', lineOperator: 'MSC', voyageOut: 'Y01E' }))).body.id;
    await expectOk(planner.post(`/v1/visits/${visitId}/load-lists`, {
      items: [
        { move: 'LOAD', unitRef: X[0], isoType: '22G1', grossWeightKg: 22000, pod: 'SGSIN' },
        { move: 'LOAD', unitRef: X[1], isoType: '22G1', grossWeightKg: 21000, pod: 'SGSIN' },
        { move: 'LOAD', unitRef: X[2], isoType: '22G1', grossWeightKg: 15000, pod: 'INNSA' },
        { move: 'LOAD', unitRef: X[3], isoType: '22R1', grossWeightKg: 18000, pod: 'SGSIN', isReefer: true },
        { move: 'LOAD', unitRef: X[4], isoType: '22G1', grossWeightKg: 12000, pod: 'SGSIN', dgClass: '8', dgUnNumber: '1830' },
        { move: 'LOAD', unitRef: X[5], isoType: '22R1', grossWeightKg: 17000, pod: 'SGSIN', isReefer: true },
      ],
    }));
  });
  afterAll(async () => app.close());

  it('keeps planner ranges, refuses overlaps and bad bounds', async () => {
    const planner = await t.as(['tos:planner']);
    const r = await expectOk(planner.post('/v1/yard/ranges', { name: 'YRD-01 SGSIN', block: 'EX', bayFrom: 3, bayTo: 4, purpose: 'EXPORT', visitId, pod: 'SGSIN', priority: 10 }));
    expect(r.body).toMatchObject({ block: 'EX', bayFrom: 3, bayTo: 4, rowFrom: 1, rowTo: 2, visitRef: 'YRD-01', occupied: 0, slots: 12 });
    expect((await planner.post('/v1/yard/ranges', { name: 'Clash', block: 'EX', bayFrom: 4, bayTo: 4 })).status).toBe(409);
    expect((await planner.post('/v1/yard/ranges', { name: 'Too far', block: 'EX', bayFrom: 1, bayTo: 9 })).status).toBe(422);
    const tmp = await expectOk(planner.post('/v1/yard/ranges', { name: 'Empties', block: 'EX', bayFrom: 2, bayTo: 2, purpose: 'EMPTY', line: 'MSC' }));
    await expectOk(planner.post(`/v1/yard/ranges/${tmp.body.id}/release`, {}));
    expect((await expectOk(planner.get('/v1/yard/ranges'))).body.map((x: any) => x.name)).toEqual(['YRD-01 SGSIN']);
  });

  it('gates exports into their range, stacked by group, and explains the choice', async () => {
    const gate = await t.as(['tos:gate']);
    const planner = await t.as(['tos:planner']);
    const preview = await expectOk(planner.post('/v1/yard/allocate-preview', { unitRef: X[0] }));
    expect(preview.body).toMatchObject({ block: 'EX', position: 'EX-03-01-1', reason: 'range YRD-01 SGSIN' });

    const g0 = await expectOk(gate.post('/v1/gate/transactions', { direction: 'IN', unitRef: X[0], truckPlate: 'Y 1' }));
    const g1 = await expectOk(gate.post('/v1/gate/transactions', { direction: 'IN', unitRef: X[1], truckPlate: 'Y 2' }));
    expect([g0.body.position, g1.body.position]).toEqual(['EX-03-01-1', 'EX-03-01-2']); // same vessel, POD, size and weight class
    // INNSA is not the range's POD: general space, not the reserved bays.
    const g2 = await expectOk(gate.post('/v1/gate/transactions', { direction: 'IN', unitRef: X[2], truckPlate: 'Y 3' }));
    expect(g2.body.position).not.toMatch(/^EX-0[34]-/);
    expect(g2.body.position).toBe('A1-01-01-1'); // the harness's general block comes first
  });

  it('puts reefers on plugs and DG units in their zone', async () => {
    const gate = await t.as(['tos:gate']);
    const r = await expectOk(gate.post('/v1/gate/transactions', { direction: 'IN', unitRef: X[3], truckPlate: 'Y 4' }));
    expect(r.body.position).toMatch(/^RF-/);
    // RF has one plug, and no other block has any: the second reefer has nowhere to go.
    const full = await gate.post('/v1/gate/transactions', { direction: 'IN', unitRef: X[5], truckPlate: 'Y 6' });
    expect(full.status).toBe(409);
    expect(full.body.detail).toMatch(/reefer/);
    // Class 8 is not allowed in the class-3 DG block, and DG units may not go elsewhere once DG blocks exist.
    const dg = await gate.post('/v1/gate/transactions', { direction: 'IN', unitRef: X[4], truckPlate: 'Y 5' });
    expect(dg.status).toBe(409);
    expect(dg.body.detail).toMatch(/DG 8/);
  });

  it('checks explicit slots against the rules and refuses to dig out a buried unit', async () => {
    const planner = await t.as(['tos:planner']);
    const op = await t.as(['tos:operator']);
    const admin = t.admin;
    await expectOk(admin.post('/v1/equipment-pools', { code: 'P', name: 'RTGs' }));
    await expectOk(admin.post('/v1/equipment', { code: 'RTG9', kind: 'RTG', pool: 'P' }));
    await expectOk(op.post('/v1/equipment/RTG9/status', { status: 'IDLE' }));
    await expectOk(planner.post('/v1/work-queues', { code: 'HK', name: 'Housekeeping', powKind: 'HOUSEKEEPING', pool: 'P' }));

    // X0 is under X1 at EX-03-01: digging it out first is refused at completion.
    await expectOk(planner.post('/v1/work-queues/HK/instructions', { moves: [{ unitRef: X[0], toPosition: 'EX-02-01-1' }] }));
    const job = (await expectOk(op.post('/v1/dispatch/next', { equipment: 'RTG9' }))).body.job;
    const buried = await op.post(`/v1/work-instructions/${job.id}/complete`, { equipment: 'RTG9' });
    expect(buried.status).toBe(409);
    expect(buried.body.detail).toMatch(new RegExp(`under ${X[1]}`));
    await expectOk(op.post(`/v1/work-instructions/${job.id}/reject`, { equipment: 'RTG9', reason: 'buried' }));
    // Floating and size-mixing targets are refused too.
    const floating = await op.post(`/v1/work-instructions/${job.id}/complete`, { equipment: 'RTG9' });
    expect(floating.status).toBe(409); // no longer with RTG9
    // A more urgent queue for X2 (alone in its stack): a target with nothing under it is refused.
    await expectOk(planner.post('/v1/work-queues', { code: 'HK1', name: 'Urgent', powKind: 'HOUSEKEEPING', pool: 'P', priority: 1 }));
    await expectOk(planner.post('/v1/work-queues/HK1/instructions', { moves: [{ unitRef: X[2] }] }));
    const j2 = (await expectOk(op.post('/v1/dispatch/next', { equipment: 'RTG9' }))).body.job;
    expect(j2.unitRef).toBe(X[2]);
    const float = await op.post(`/v1/work-instructions/${j2.id}/complete`, { equipment: 'RTG9', toPosition: 'EX-02-02-2' });
    expect(float.status).toBe(409);
    expect(float.body.detail).toMatch(/float/);
    const mixed = await op.post(`/v1/work-instructions/${j2.id}/complete`, { equipment: 'RTG9', toPosition: 'RF-02-01-1' });
    expect(mixed.status).toBe(201); // a plain unit may use a reefer slot when it must (scored, not forbidden)
  });
});
