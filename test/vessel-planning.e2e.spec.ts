import { INestApplication } from '@nestjs/common';
import { el, parseEdifact } from '../src/edi/edifact';
import { container, createApp, expectOk, provisionTenant } from './support/harness';

/** Phase 1 vessel planning: berth plan, BAPLIE in/out, restows, stow plan, crane split into crane queues. */
describe('Vessel planning', () => {
  let app: INestApplication;
  let t: Awaited<ReturnType<typeof provisionTenant>>;
  let v1: string;
  let v2: string;
  const U = Array.from({ length: 7 }, (_, i) => container('PLNU', 700001 + i));
  const E = Array.from({ length: 3 }, (_, i) => container('EXPU', 710001 + i));
  const day = (d: number, h = 0) => new Date(Date.UTC(2027, 0, 10 + d, h)).toISOString();

  // [cell, unit, iso, pod]
  const arrival: [string, string, string, string][] = [
    ['0010282', U[0], '22G1', 'AEKHL'], // deck, discharge
    ['0010284', U[1], '22G1', 'SGSIN'], // on top of U0 -> restow
    ['0020482', U[2], '42G1', 'AEKHL'], // 40' deck, discharge
    ['0060206', U[3], '42G1', 'AEKHL'], // hold of hatch 1, discharge
    ['0050282', U[4], '22G1', 'SGSIN'], // deck of hatch 1 -> restow (hatch cover)
    ['0130282', U[5], '22G1', 'AEKHL'], // hatch 3, discharge
    ['0170282', U[6], '22G1', 'SGSIN'], // remains on board
  ];
  const baplie = (cells: [string, string, string, string][], voyage = 'PL01W') => {
    const body = [
      'UNH+1+BAPLIE:D:95B:UN:SMDG22',
      'BGM++BAP001+9',
      'DTM+137:202701100800:201',
      `TDT+20+${voyage}+++MSC:172:20+++9600001:146::PLAN STAR`,
      'LOC+5+CNSHA:139:6',
      ...cells.flatMap(([cell, unit, iso, pod], i) => [
        `LOC+147+${cell}::5`,
        `MEA+WT++KGM:${18000 + i * 500}`,
        'LOC+9+CNSHA:139:6',
        `LOC+11+${pod}:139:6`,
        `EQD+CN+${unit}+${iso}+++5`,
        'NAD+CA+MSC:172:20',
        ...(i === 3 ? ['DGS+IMD+3+1203'] : []),
      ]),
    ];
    return ['UNB+UNOA:2+MSC+KHLMPT+270110:0800+BP0001', ...body, `UNT+${body.length + 1}+1`, 'UNZ+1+BP0001'].map((s) => s + "'").join('\n');
  };

  beforeAll(async () => {
    app = await createApp();
    t = await provisionTenant(app);
    const admin = t.admin;
    await expectOk(admin.post('/v1/terminal/berths', { code: 'B1', name: 'Berth 1', startMarkM: 0, lengthM: 300, depthM: 14 }));
    await expectOk(admin.post('/v1/terminal/berths', { code: 'B2', name: 'Berth 2', startMarkM: 300, lengthM: 200, depthM: 10 }));
    await expectOk(admin.post('/v1/yard-blocks', { facilityCode: t.facility, yardCode: 'Y1', code: 'A9', blockType: 'CONTAINER_STACK', bays: 10, rows: 4, tiers: 4 }));
    for (const qc of ['QC01', 'QC02']) await expectOk(admin.post('/v1/equipment', { code: qc, kind: 'QC' }));
    await expectOk(admin.post('/v1/equipment', { code: 'RS01', kind: 'RS' }));
  });
  afterAll(async () => app.close());

  it('keeps vessel particulars and the bay-plan profile', async () => {
    const planner = await t.as(['tos:planner']);
    await expectOk(planner.post('/v1/vessels', { imo: '9600001', name: 'PLAN STAR', loaM: 200, maxDraftM: 12 }));
    await expectOk(planner.post('/v1/vessels', { imo: '9600002', name: 'NO LENGTH' }));
    const up = await expectOk(planner.put('/v1/vessels/9600001', { maxBay: 19, maxRow: 8, holdTiers: 4, deckTiers: 3 }));
    expect(up.body).toMatchObject({ name: 'PLAN STAR', loaM: 200, maxBay: 19, deckTiers: 3 });
    expect((await expectOk(planner.get('/v1/vessels'))).body.map((v: any) => v.imo)).toEqual(expect.arrayContaining(['9600001', '9600002']));
  });

  it('places visits on the berth plan and refuses clashes, short and shallow berths', async () => {
    const planner = await t.as(['tos:planner']);
    v1 = (await expectOk(planner.post('/v1/visits', { visitRef: 'PLN-01', imo: '9600001', lineOperator: 'MSC', voyageIn: 'PL01W', voyageOut: 'PL01E' }))).body.id;
    v2 = (await expectOk(planner.post('/v1/visits', { visitRef: 'PLN-02', imo: '9600001', voyageIn: 'PL02W' }))).body.id;
    const v3 = (await expectOk(planner.post('/v1/visits', { visitRef: 'PLN-03', imo: '9600002' }))).body.id;

    const ok = await expectOk(planner.put(`/v1/visits/${v1}/berth-plan`, { berth: 'B1', etb: day(0, 6), etd: day(1, 18) }));
    expect(ok.body).toMatchObject({ berth: 'B1', quayFromM: 0, quayToM: 200 });

    const clash = await planner.put(`/v1/visits/${v2}/berth-plan`, { berth: 'B1', quayFromM: 100, etb: day(1), etd: day(2) });
    expect(clash.status).toBe(409);
    expect(clash.body.detail).toMatch(/PLN-01/);
    const short = await planner.put(`/v1/visits/${v2}/berth-plan`, { berth: 'B1', quayFromM: 150, etb: day(5), etd: day(6) });
    expect(short.status).toBe(409);
    const shallow = await planner.put(`/v1/visits/${v2}/berth-plan`, { berth: 'B2', etb: day(1), etd: day(2) });
    expect(shallow.status).toBe(409);
    expect(shallow.body.detail).toMatch(/draft/);
    const backwards = await planner.put(`/v1/visits/${v2}/berth-plan`, { berth: 'B1', etb: day(3), etd: day(2) });
    expect(backwards.status).toBe(422);
    const noLoa = await planner.put(`/v1/visits/${v3}/berth-plan`, { berth: 'B1', etb: day(8), etd: day(9) });
    expect(noLoa.status).toBe(422);
    // Same quay, after PLN-01 leaves: fine.
    await expectOk(planner.put(`/v1/visits/${v2}/berth-plan`, { berth: 'B1', quayFromM: 50, etb: day(2), etd: day(3) }));

    const plan = await expectOk(planner.get(`/v1/berth-plan?from=${day(-1)}&to=${day(10)}`));
    expect(plan.body.berths.map((b: any) => b.code)).toEqual(['B1', 'B2']);
    const byRef = Object.fromEntries(plan.body.visits.map((v: any) => [v.visitRef, v]));
    expect(byRef['PLN-01']).toMatchObject({ berth: 'B1', quayFromM: 0, loaM: 200 });
    expect(byRef['PLN-02']).toMatchObject({ quayFromM: 50 });
    expect(byRef['PLN-03']).toMatchObject({ quayFromM: null }); // waiting to be placed
  });

  it('reads the arrival BAPLIE: discharge list for this port, restows and remain-on-board', async () => {
    const edi = await t.as(['tos:edi']);
    const overlap = await edi.postText('/v1/edi/inbound', baplie([['0010282', U[0], '22G1', 'AEKHL'], ['0020282', U[2], '42G1', 'AEKHL']]));
    expect(overlap.status).toBe(422);
    expect(overlap.body.error).toMatch(/overlaps/);

    const r = await expectOk(edi.postText('/v1/edi/inbound', baplie(arrival)));
    expect(r.body).toMatchObject({ status: 'ACCEPTED', messageType: 'BAPLIE', result: { cells: 7, discharge: 4, restow: 2, remainOnBoard: 1 } });

    const planner = await t.as(['tos:planner']);
    const moves = (await expectOk(planner.get(`/v1/visits/${v1}/moves`))).body;
    expect(moves.filter((m: any) => m.moveKind === 'DISCHARGE')).toHaveLength(4);
    const [u3] = (await expectOk(planner.get(`/v1/units?ref=${U[3]}`))).body;
    expect(u3).toMatchObject({ state: 'ADVISED', dgClass: '3' });

    // Re-sending is idempotent.
    const again = await expectOk(edi.postText('/v1/edi/inbound', baplie(arrival)));
    expect(again.body.result).toMatchObject({ discharge: 4 });
    expect((await expectOk(planner.get(`/v1/visits/${v1}/moves`))).body.filter((m: any) => m.moveKind === 'DISCHARGE')).toHaveLength(4);
  });

  it('plans load cells with size and occupancy checks', async () => {
    const planner = await t.as(['tos:planner']);
    await expectOk(planner.post(`/v1/visits/${v1}/load-lists`, {
      items: [
        { move: 'LOAD', unitRef: E[0], isoType: '22G1', grossWeightKg: 15000, pod: 'SGSIN' },
        { move: 'LOAD', unitRef: E[1], isoType: '45G1', grossWeightKg: 25000, pod: 'SGSIN' },
        { move: 'LOAD', unitRef: E[2], isoType: '22G1', grossWeightKg: 12000, pod: 'SGSIN' },
      ],
    }));
    const bad = await planner.put(`/v1/visits/${v1}/stow-plan`, {
      assignments: [{ unitRef: E[0], cell: '0020282' }, { unitRef: E[1], cell: '0100282' }, { unitRef: E[2], cell: '0010284' }, { unitRef: U[0], cell: '0090282' }],
    });
    expect(bad.status).toBe(422);
    const msgs = Object.fromEntries(bad.body.errors.map((e: any) => [e.unitRef, e.message]));
    expect(msgs[E[0]]).toMatch(/odd bay/);
    expect(msgs[E[2]]).toMatch(new RegExp(`taken by ${U[1]}`));
    expect(msgs[U[0]]).toMatch(/not on the load list/);
    expect(msgs[E[1]]).toBeUndefined();

    // A discharge cell is free for loading (it will be empty by then); two loads cannot share one.
    const dup = await planner.put(`/v1/visits/${v1}/stow-plan`, { assignments: [{ unitRef: E[0], cell: '0090482' }, { unitRef: E[2], cell: '0090482' }] });
    expect(dup.status).toBe(422);
    const ok = await expectOk(planner.put(`/v1/visits/${v1}/stow-plan`, {
      assignments: [{ unitRef: E[0], cell: '0010482' }, { unitRef: E[1], cell: '0100282' }, { unitRef: E[2], cell: '0090482' }],
    }));
    expect(ok.body).toMatchObject({ planned: 3 });

    const bp = (await expectOk(planner.get(`/v1/visits/${v1}/bay-plan`))).body;
    expect(bp.counts).toEqual({ DISCHARGE: 4, RESTOW: 2, ROB: 1, LOAD: 3 });
    expect(bp.profile).toMatchObject({ maxBay: 19, maxRow: 8, holdTiers: 4, deckTiers: 3 });
    expect(bp.unplannedLoads).toEqual([]);
    expect(bp.cells.find((c: any) => c.cell === '0060206')).toMatchObject({ deck: false, state: 'DISCHARGE', dgClass: '3' });
  });

  it('splits the work between cranes in contiguous bay ranges and builds sequenced crane queues', async () => {
    const planner = await t.as(['tos:planner']);
    const notCrane = await planner.post(`/v1/visits/${v1}/crane-split`, { cranes: ['QC01', 'RS01'] });
    expect(notCrane.status).toBe(422);
    // A load without a cell stays out of the split and is reported.
    await expectOk(planner.put(`/v1/visits/${v1}/stow-plan`, { assignments: [{ unitRef: E[2], cell: null }] }));
    const partial = await expectOk(planner.post(`/v1/visits/${v1}/crane-split`, { cranes: ['QC01', 'QC02'] }));
    expect(partial.body).toMatchObject({ totalMoves: 10, withoutCell: [E[2]] });
    await expectOk(planner.put(`/v1/visits/${v1}/stow-plan`, { assignments: [{ unitRef: E[2], cell: '0090482' }] }));

    // hatch 0: 2 discharges + 1 load + restow (2) = 5; hatch 1: 1 + restow (2) = 3; hatch 2: 2 loads; hatch 3: 1 -> best split 5 | 6
    const split = await expectOk(planner.post(`/v1/visits/${v1}/crane-split`, { cranes: ['QC01', 'QC02'], movesPerHour: 20 }));
    expect(split.body).toMatchObject({ totalMoves: 11, movesPerHour: 20, vesselHours: 0.3, withoutCell: [] });
    expect(split.body.cranes).toEqual([
      expect.objectContaining({ crane: 'QC01', bayFrom: 1, bayTo: 2, moves: 5, restows: 1 }),
      expect.objectContaining({ crane: 'QC02', bayFrom: 5, bayTo: 13, moves: 6, restows: 1 }),
    ]);
    const q1 = (await expectOk(planner.get('/v1/work-queues/PLN-01-QC01'))).body;
    expect(q1).toMatchObject({ powKind: 'VESSEL', equipment: 'QC01', planned: 3 });
    // discharge deck by bay, then the load
    expect(q1.instructions.map((i: any) => [i.unitRef, i.moveKind])).toEqual([[U[0], 'DISCHARGE'], [U[2], 'DISCHARGE'], [E[0], 'LOAD']]);
    const q2 = (await expectOk(planner.get('/v1/work-queues/PLN-01-QC02'))).body;
    expect(q2.instructions.map((i: any) => i.unitRef)).toEqual([U[3], E[2], E[1], U[5]]);

    const current = (await expectOk(planner.get(`/v1/visits/${v1}/crane-split`))).body;
    expect(current.queues.map((q: any) => [q.crane, q.bayFrom, q.bayTo, q.planned])).toEqual([['QC01', 1, 2, 3], ['QC02', 5, 13, 4]]);

    // One crane breaks down before work starts: re-split onto QC02 alone; QC01's queue closes.
    const solo = await expectOk(planner.post(`/v1/visits/${v1}/crane-split`, { cranes: ['QC02'] }));
    expect(solo.body.cranes).toEqual([expect.objectContaining({ crane: 'QC02', bayFrom: 1, bayTo: 13, moves: 11 })]);
    expect((await expectOk(planner.get('/v1/work-queues/PLN-01-QC01'))).body).toMatchObject({ status: 'CLOSED', planned: 0 });
    expect((await expectOk(planner.get('/v1/work-queues/PLN-01-QC02'))).body.planned).toBe(7);
  });

  it('works the crane queue from the device API and keeps the bay plan current', async () => {
    const op = await t.as(['tos:operator']);
    const edi = await t.as(['tos:edi']);
    await expectOk(op.post(`/v1/visits/${v1}/arrive`, { berth: 'B1' }));
    await expectOk(op.post('/v1/equipment/QC02/status', { status: 'IDLE', operator: 'Ravi' }));
    const job = (await expectOk(op.post('/v1/dispatch/next', { equipment: 'QC02' }))).body.job;
    expect(job).toMatchObject({ unitRef: U[0], moveKind: 'DISCHARGE', fromPosition: '0010282' });
    await expectOk(op.post(`/v1/work-instructions/${job.id}/complete`, { equipment: 'QC02' }));

    const bp = (await expectOk(op.get(`/v1/visits/${v1}/bay-plan`))).body;
    expect(bp.cells.find((c: any) => c.cell === '0010282')).toMatchObject({ state: 'DISCHARGED' });
    const moves = (await expectOk(op.get(`/v1/visits/${v1}/moves`))).body;
    expect(moves.find((m: any) => m.unitRef === U[0])).toMatchObject({ fromPosition: '0010282', status: 'COMPLETED' });

    const late = await edi.postText('/v1/edi/inbound', baplie(arrival));
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/Discharge has started/);
  });

  it('produces the departure BAPLIE: cargo remaining on board, back in its cells', async () => {
    const edi = await t.as(['tos:edi']);
    const r = await expectOk(edi.get(`/v1/edi/outbound/baplie/${v1}?nextPort=SGSIN`));
    expect(r.headers['content-type']).toMatch(/edifact/);
    const segs = parseEdifact(r.text);
    expect(el(segs.find((s) => s.tag === 'UNH'), 2)).toBe('BAPLIE');
    expect(el(segs.find((s) => s.tag === 'TDT'), 2)).toBe('PL01E');
    const cells = segs.filter((s) => s.tag === 'LOC' && el(s, 1) === '147').map((s) => el(s, 2));
    expect(cells).toEqual(['0010284', '0050282', '0170282']);
    const units = segs.filter((s) => s.tag === 'EQD').map((s) => el(s, 2));
    expect(units).toEqual([U[1], U[4], U[6]]);
    expect(segs.find((s) => s.tag === 'LOC' && el(s, 1) === '61')).toBeTruthy();
    expect(Number(el(segs.find((s) => s.tag === 'UNT'), 1))).toBe(segs.filter((s) => !['UNB', 'UNZ'].includes(s.tag)).length);
  });

  it('keeps vessel plans inside the tenant', async () => {
    const other = await provisionTenant(app);
    expect((await other.admin.get(`/v1/visits/${v1}/bay-plan`)).status).toBe(404);
    expect((await other.admin.post(`/v1/visits/${v1}/crane-split`, { cranes: ['QC01'] })).status).toBe(404);
    expect((await expectOk(other.admin.get('/v1/berth-plan'))).body.visits).toEqual([]);
  });
});
