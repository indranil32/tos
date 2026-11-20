import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { client, container, createApp, expectOk, issuerFor, provisionTenant, token } from './support/harness';

/**
 * Phase 0 foundations: terminal model, equipment, work queues, rule-based dispatch, breakdown re-routing,
 * and live events over Server-Sent Events.
 */
describe('Terminal model, equipment and work queues', () => {
  let app: INestApplication;
  let baseUrl: string;
  let t: Awaited<ReturnType<typeof provisionTenant>>;
  let visitId: string;
  const imp1 = container('TGHU', 500001);
  const imp2 = container('TGHU', 500002);
  const imp3 = container('TGHU', 500003);

  beforeAll(async () => {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    t = await provisionTenant(app);
  });
  afterAll(async () => app.close());

  it('records the terminal layout: berths, rail tracks, gate lanes, block rules and a depot corridor', async () => {
    const admin = t.admin;
    await expectOk(admin.post('/v1/terminal/berths', { code: 'B1', name: 'Berth 1', startMarkM: 0, lengthM: 300, depthM: 14, map: { x: 0, y: 0, w: 300, h: 20 } }));
    await expectOk(admin.post('/v1/terminal/berths', { code: 'R1', name: 'RoRo ramp', berthKind: 'RORO_RAMP', startMarkM: 300, lengthM: 120 }));
    await expectOk(admin.post('/v1/terminal/rail-tracks', { code: 'T1', lengthM: 600, maxWagons: 30 }));
    await expectOk(admin.post('/v1/terminal/gate-lanes', { code: 'G1', direction: 'IN', hasOcr: true }));
    await expectOk(admin.post('/v1/terminal/gate-lanes', { code: 'TD', direction: 'BOTH', laneKind: 'TROUBLE' }));
    const reefer = await expectOk(admin.post('/v1/yard-blocks', {
      facilityCode: t.facility, yardCode: 'Y1', code: 'RF', blockType: 'CONTAINER_STACK', bays: 4, rows: 2, tiers: 3,
      equipmentKind: 'RTG', reeferPlugs: 24, dgClasses: [], allowedSizes: ['20', '40'], maxStackKg: 90000,
    }));
    expect(reefer.body).toMatchObject({ capacityUnit: 'SLOTS', reeferPlugs: 24, allowedSizes: ['20', '40'] });
    const bad = await admin.post('/v1/yard-blocks', { facilityCode: t.facility, yardCode: 'Y1', code: 'DG', blockType: 'CONTAINER_STACK', dgClasses: ['x'] });
    expect(bad.status).toBe(422);

    await expectOk(admin.post('/v1/facilities', { complexCode: 'CPLX', code: 'ICD1', name: 'Inland depot', kinds: ['DRY_PORT', 'DEPOT', 'CFS'] }));
    await expectOk(admin.post('/v1/terminal/links', { toFacility: 'ICD1', mode: 'RAIL', transitHours: 6 }));

    const map = await expectOk(admin.get('/v1/terminal'));
    expect(map.body.kinds).toEqual(['SEAPORT']);
    expect(map.body.berths.map((b: any) => b.code)).toEqual(['B1', 'R1']);
    expect(map.body.berths[0].map).toMatchObject({ w: 300 });
    expect(map.body.blocks.map((b: any) => b.code)).toEqual(expect.arrayContaining(['A1', 'L1', 'RF']));
    expect(map.body.railTracks).toHaveLength(1);
    expect(map.body.gateLanes.map((l: any) => l.laneKind)).toEqual(['STANDARD', 'TROUBLE']);
    expect(map.body.links).toEqual([expect.objectContaining({ fromFacility: t.facility, toFacility: 'ICD1', mode: 'RAIL', toKinds: ['DRY_PORT', 'DEPOT', 'CFS'] })]);

    const facilities = await expectOk(admin.get('/v1/facilities'));
    expect(facilities.body.find((f: any) => f.code === 'ICD1').kinds).toEqual(['DRY_PORT', 'DEPOT', 'CFS']);
  });

  it('keeps equipment, pools, shifts and gangs', async () => {
    const admin = t.admin;
    await expectOk(admin.post('/v1/equipment-pools', { code: 'HK', name: 'Housekeeping RTGs' }));
    await expectOk(admin.post('/v1/equipment', { code: 'QC01', kind: 'QC', twinLift: true }));
    await expectOk(admin.post('/v1/equipment', { code: 'RTG01', kind: 'RTG', pool: 'HK' }));
    await expectOk(admin.post('/v1/equipment', { code: 'RTG02', kind: 'RTG', pool: 'HK' }));
    const bad = await admin.post('/v1/equipment', { code: 'X1', kind: 'BOAT' });
    expect(bad.status).toBe(422);
    await expectOk(admin.post('/v1/shifts', { code: 'N', name: 'Night', startsAt: '19:00', endsAt: '07:00' }));
    const gang = await expectOk(admin.post('/v1/gangs', { code: 'G-A', name: 'Gang A', shift: 'N', members: ['Ali', 'Ravi'] }));
    expect(gang.body.members).toEqual(['Ali', 'Ravi']);
    expect((await expectOk(admin.get('/v1/gangs'))).body[0]).toMatchObject({ shift: 'N' });

    const list = await expectOk(admin.get('/v1/equipment'));
    expect(list.body.map((e: any) => [e.code, e.status])).toEqual([['QC01', 'OFFLINE'], ['RTG01', 'OFFLINE'], ['RTG02', 'OFFLINE']]);
    const pools = await expectOk(admin.get('/v1/equipment-pools'));
    expect(pools.body).toEqual([expect.objectContaining({ code: 'HK', machines: 2 })]);
  });

  it('dispatches vessel discharge moves from a crane queue', async () => {
    const planner = await t.as(['tos:planner']);
    const op = await t.as(['tos:operator']);
    await expectOk(planner.post('/v1/vessels', { imo: '9700001', name: 'WORK STAR' }));
    visitId = (await expectOk(planner.post('/v1/visits', { visitRef: 'WRK-01', imo: '9700001', lineOperator: 'MSC', voyageIn: 'W01' }))).body.id;
    const items = [imp1, imp2, imp3].map((unitRef) => ({ move: 'DISCHARGE', unitRef, isoType: '22G1', grossWeightKg: 20000, pol: 'CNSHA', pod: 'AEKHL' }));
    await expectOk(planner.post(`/v1/visits/${visitId}/load-lists`, { items }));
    await expectOk(op.post(`/v1/visits/${visitId}/arrive`, { berth: 'B1' }));

    const noVisit = await planner.post('/v1/work-queues', { code: 'QC01-WRK', name: 'QC01 on WRK-01', powKind: 'VESSEL', equipment: 'QC01' });
    expect(noVisit.status).toBe(422);
    await expectOk(planner.post('/v1/work-queues', { code: 'QC01-WRK', name: 'QC01 on WRK-01', powKind: 'VESSEL', visitId, equipment: 'QC01', priority: 10 }));

    const planned = (await expectOk(planner.get('/v1/work-instructions?status=PLANNED&unassigned=true'))).body;
    expect(planned).toHaveLength(3);
    // Planner sequence: imp3 first.
    const byRef = Object.fromEntries(planned.map((w: any) => [w.unitRef, w.id]));
    await expectOk(planner.post('/v1/work-queues/QC01-WRK/instructions', { instructionIds: [byRef[imp1], byRef[imp2], byRef[imp3]] }));
    await expectOk(planner.put('/v1/work-queues/QC01-WRK/sequence', { instructionIds: [byRef[imp3], byRef[imp1], byRef[imp2]] }));

    const offline = await op.post('/v1/dispatch/next', { equipment: 'QC01' });
    expect(offline.status).toBe(409);
    await expectOk(op.post('/v1/equipment/QC01/status', { status: 'IDLE', operator: 'Ravi' }));

    for (const expected of [imp3, imp1]) {
      const job = (await expectOk(op.post('/v1/dispatch/next', { equipment: 'QC01' }))).body.job;
      expect(job).toMatchObject({ unitRef: expected, moveKind: 'DISCHARGE', status: 'DISPATCHED', equipment: 'QC01', fromPosition: 'VESSEL' });
      // Asking again returns the same job (idempotent for a device that lost the response).
      expect((await expectOk(op.post('/v1/dispatch/next', { equipment: 'QC01' }))).body.job.id).toBe(job.id);
      const started = await expectOk(op.post(`/v1/work-instructions/${job.id}/start`, { equipment: 'QC01', version: job.version }));
      const stale = await op.post(`/v1/work-instructions/${job.id}/complete`, { equipment: 'QC01', version: job.version });
      expect(stale.status).toBe(409);
      const done = await expectOk(op.post(`/v1/work-instructions/${job.id}/complete`, { equipment: 'QC01', version: started.body.version }));
      expect(done.body).toMatchObject({ status: 'COMPLETED', toPosition: expect.stringMatching(/^A1-/) });
    }
    const [u] = (await expectOk(op.get(`/v1/units?ref=${imp3}`))).body;
    expect(u).toMatchObject({ state: 'IN_YARD' });
    const qc = (await expectOk(op.get('/v1/equipment/QC01'))).body;
    expect(qc).toMatchObject({ status: 'IDLE', openJobs: 0 });
    expect(qc.history[0]).toMatchObject({ status: 'IDLE', operator: 'Ravi' });

    const q = (await expectOk(planner.get('/v1/work-queues/QC01-WRK'))).body;
    expect(q).toMatchObject({ planned: 1, active: 0, completed: 2 });
    expect(q.instructions[0]).toMatchObject({ unitRef: imp2, status: 'PLANNED' });
  });

  it('runs a pooled housekeeping queue and re-routes jobs when a machine breaks down', async () => {
    const planner = await t.as(['tos:planner']);
    const op = await t.as(['tos:operator']);
    await expectOk(planner.post('/v1/work-queues', { code: 'HK-A1', name: 'Night housekeeping', powKind: 'HOUSEKEEPING', pool: 'HK', priority: 80 }));
    await expectOk(planner.post('/v1/work-queues/HK-A1/instructions', { moves: [{ unitRef: imp1, toPosition: 'A1-02-02-1' }, { unitRef: imp3 }] }));
    const dup = await planner.post('/v1/work-queues/HK-A1/instructions', { moves: [{ unitRef: imp3 }] });
    expect(dup.status).toBe(409);
    const notInYard = await planner.post('/v1/work-queues/HK-A1/instructions', { moves: [{ unitRef: imp2 }] });
    expect(notInYard.status).toBe(409);

    await expectOk(op.post('/v1/equipment/RTG01/status', { status: 'IDLE', operator: 'Ali' }));
    await expectOk(op.post('/v1/equipment/RTG02/status', { status: 'IDLE', operator: 'Sam' }));
    const j1 = (await expectOk(op.post('/v1/dispatch/next', { equipment: 'RTG01' }))).body.job;
    expect(j1).toMatchObject({ unitRef: imp1, moveKind: 'HOUSEKEEPING', plannedPosition: 'A1-02-02-1' });
    // QC01 is not in the pool: no housekeeping for it.
    expect((await expectOk(op.post('/v1/dispatch/next', { equipment: 'QC01' }))).body.job).toMatchObject({ unitRef: imp2 });

    const broken = await expectOk(op.post('/v1/equipment/RTG01/status', { status: 'BREAKDOWN', reason: 'Hydraulic leak' }));
    expect(broken.body).toMatchObject({ status: 'BREAKDOWN', releasedJobs: 1, openJobs: 0 });
    const notMine = await op.post(`/v1/work-instructions/${j1.id}/complete`, { equipment: 'RTG01' });
    expect(notMine.status).toBe(409);

    const j1again = (await expectOk(op.post('/v1/dispatch/next', { equipment: 'RTG02' }))).body.job;
    expect(j1again).toMatchObject({ id: j1.id, equipment: 'RTG02' });
    const done = await expectOk(op.post(`/v1/work-instructions/${j1.id}/complete`, { equipment: 'RTG02' }));
    expect(done.body).toMatchObject({ status: 'COMPLETED', toPosition: 'A1-02-02-1' });
    const yard = (await expectOk(op.get('/v1/yard'))).body;
    const a1 = yard.blocks.find((b: any) => b.code === 'A1');
    expect(a1.units.find((u: any) => u.unitRef === imp1).position).toBe('A1-02-02-1');

    // Second move has no target: the allocator picks a free slot; a rejected job goes back to the queue.
    const j2 = (await expectOk(op.post('/v1/dispatch/next', { equipment: 'RTG02' }))).body.job;
    expect(j2.unitRef).toBe(imp3);
    const back = await expectOk(op.post(`/v1/work-instructions/${j2.id}/reject`, { equipment: 'RTG02', reason: 'Slot blocked' }));
    expect(back.body).toMatchObject({ status: 'PLANNED', equipment: null });
    expect((await expectOk(op.get('/v1/equipment/RTG02'))).body.status).toBe('IDLE');
    const j2b = (await expectOk(op.post('/v1/dispatch/next', { equipment: 'RTG02' }))).body.job;
    const moved = await expectOk(op.post(`/v1/work-instructions/${j2b.id}/complete`, { equipment: 'RTG02' }));
    expect(moved.body.toPosition).toMatch(/^A1-/);
    expect((await expectOk(op.post('/v1/dispatch/next', { equipment: 'RTG02' }))).body.job).toBeNull();

    const busy = await planner.post('/v1/work-queues/QC01-WRK/status', { status: 'CLOSED' });
    expect(busy.status).toBe(409); // QC01 still holds imp2
  });

  it('isolates equipment and queues between tenants and facilities', async () => {
    const other = await provisionTenant(app);
    expect((await expectOk(other.admin.get('/v1/equipment'))).body).toEqual([]);
    expect((await expectOk(other.admin.get('/v1/work-queues'))).body).toEqual([]);
    const crossTenant = await other.admin.post('/v1/dispatch/next', { equipment: 'RTG02' });
    expect(crossTenant.status).toBe(404);
    const elsewhere = client(app, await token({ issuer: issuerFor(t.code), roles: ['tos:operator'], facilities: ['ICD1'] }), t.facility);
    expect((await elsewhere.get('/v1/equipment')).status).toBe(403);
  });

  it('streams committed events live over SSE, scoped to the tenant and facility', async () => {
    const bearer = await token({ issuer: issuerFor(t.code), roles: ['tos:viewer'] });
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/v1/stream?facility=${t.facility}`, { headers: { Authorization: `Bearer ${bearer}` }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (re: RegExp) => {
      const deadline = Date.now() + 5000;
      while (!re.test(text)) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${re}; got ${text}`);
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: boolean }>((r) => setTimeout(() => r({ value: undefined, done: false }), 200)),
        ]);
        if (done) break;
        if (value) text += decoder.decode(value, { stream: true });
      }
    };
    await until(/event: ready/);

    // Another tenant's events never arrive.
    const other = await provisionTenant(app);
    await expectOk(other.admin.post('/v1/equipment', { code: 'SPY1', kind: 'RS' }));
    const op = await t.as(['tos:operator']);
    await expectOk(op.post('/v1/equipment/RTG01/status', { status: 'MAINTENANCE', reason: 'Service' }));
    await until(/event: equipment\.status_changed/);
    const data = JSON.parse(text.split('event: equipment.status_changed\ndata: ')[1].split('\n')[0]);
    expect(data).toMatchObject({ facility: t.facility, payload: { code: 'RTG01', to: 'MAINTENANCE' } });
    expect(text).not.toMatch(/SPY1/);
    ctrl.abort();

    const unauth = await fetch(`${baseUrl}/v1/stream`);
    expect(unauth.status).toBe(401);
    const scoped = await token({ issuer: issuerFor(t.code), roles: ['tos:viewer'], facilities: ['ICD1'] });
    const denied = await fetch(`${baseUrl}/v1/stream?facility=${t.facility}`, { headers: { Authorization: `Bearer ${scoped}` } });
    expect(denied.status).toBe(403);
  });
});
