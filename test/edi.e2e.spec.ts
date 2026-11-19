import { INestApplication } from '@nestjs/common';
import { parseEdifact, el } from '../src/edi/edifact';
import { container, createApp, expectOk, provisionTenant } from './support/harness';

describe('EDI gateway: COPRAR in, COARRI and CODECO out', () => {
  let app: INestApplication;
  let t: Awaited<ReturnType<typeof provisionTenant>>;
  let visitId: string;
  const c1 = container('CMAU', 500001);
  const c2 = container('CMAU', 500002);

  const coprar = (containers: string[], voyage = '7701E') => {
    const body = [
      'UNH+1+COPRAR:D:00B:UN:SMDG21',
      'BGM+45+CPR0001+9',
      `TDT+20+${voyage}+1++CMA:172:20+++9500001:146::CMA ORION`,
      `RFF+VON:${voyage}`,
      'NAD+CA+CMA:160:166',
      ...containers.flatMap((c, i) => [
        `EQD+CN+${c}+${i === 0 ? '22G1' : '42R1'}:102:5+++5`,
        'LOC+9+CNSHA:139:6',
        'LOC+11+AEKHL:139:6',
        `MEA+AAE+VGM+KGM:${20000 + i * 1000}`,
        ...(i === 1 ? ['TMP+2+-18.0:CEL', 'SEL+SEAL123'] : []),
        'NAD+CF+MSC:160:166',
      ]),
      `CNT+16:${containers.length}`,
    ];
    const unt = `UNT+${body.length + 1}+1`;
    return ['UNB+UNOA:2+CMA+KHLMPT+261118:1200+IC0001', ...body, unt, 'UNZ+1+IC0001'].map((s) => s + "'").join('\n');
  };

  beforeAll(async () => {
    app = await createApp();
    t = await provisionTenant(app);
    const planner = await t.as(['tos:planner']);
    await expectOk(planner.post('/v1/vessels', { imo: '9500001', name: 'CMA ORION' }));
    const v = await expectOk(planner.post('/v1/visits', { visitRef: 'ORI-7701', imo: '9500001', lineOperator: 'MSC', voyageIn: '7701E' }));
    visitId = v.body.id;
  });
  afterAll(async () => app.close());

  it('maps COPRAR onto the same load-list service as the API', async () => {
    const edi = await t.as(['tos:edi']);
    const r = await expectOk(edi.postText('/v1/edi/inbound', coprar([c1, c2])));
    expect(r.body).toMatchObject({ status: 'ACCEPTED', messageType: 'COPRAR', interchangeRef: 'IC0001', result: { created: 2 } });

    const op = await t.as(['tos:operator']);
    const reefer = (await op.get(`/v1/units?ref=${c2}`)).body[0];
    expect(reefer).toMatchObject({ isReefer: true, category: 'IMPORT', pol: 'CNSHA', pod: 'AEKHL', lineOperator: 'MSC' });
  });

  it('rejects a bad interchange with an APERAK-style answer and logs it', async () => {
    const edi = await t.as(['tos:edi']);
    const unknownVoyage = await edi.postText('/v1/edi/inbound', coprar([c1], '9999X'));
    expect(unknownVoyage.status).toBe(404);
    expect(unknownVoyage.body).toMatchObject({ status: 'REJECTED', messageType: 'COPRAR' });

    const badCount = coprar([c1]).replace(/UNT\+\d+/, 'UNT+99');
    const r = await edi.postText('/v1/edi/inbound', badCount);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/UNT segment count/);

    const unsupported = await edi.postText('/v1/edi/inbound', "UNB+UNOA:2+X+Y+261118:1200+R1'UNH+1+IFTSTA:D:00B:UN'BGM+23'UNT+3+1'UNZ+1+R1'");
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.error).toMatch(/not supported yet/);
  });

  it('generates COARRI from completed discharges', async () => {
    const op = await t.as(['tos:operator']);
    await expectOk(op.post(`/v1/visits/${visitId}/arrive`, {}));
    await expectOk(op.post(`/v1/visits/${visitId}/discharges`, { unitRef: c1 }));
    await expectOk(op.post(`/v1/visits/${visitId}/discharges`, { unitRef: c2 }));

    const edi = await t.as(['tos:edi']);
    const r = await expectOk(edi.get(`/v1/edi/outbound/coarri/${visitId}`));
    expect(r.headers['content-type']).toMatch(/edifact/);
    const segs = parseEdifact(r.text);
    const eqds = segs.filter((s) => s.tag === 'EQD').map((s) => el(s, 2));
    expect(eqds).toEqual([c1, c2].sort());
    const unh = segs.findIndex((s) => s.tag === 'UNH');
    const unt = segs.find((s) => s.tag === 'UNT')!;
    expect(Number(el(unt, 1))).toBe(segs.length - unh - 1); // UNH..UNT inclusive
    expect(el(segs.find((s) => s.tag === 'TDT'), 8, 0)).toBe('9500001');
  });

  it('generates CODECO for a completed gate-out', async () => {
    const gate = await t.as(['tos:gate']);
    const g = await expectOk(gate.post('/v1/gate/transactions', { direction: 'OUT', unitRef: c1, truckPlate: 'AD 7781' }));
    const r = await expectOk(gate.get(`/v1/edi/outbound/codeco/${g.body.id}`));
    const segs = parseEdifact(r.text);
    expect(el(segs.find((s) => s.tag === 'UNH'), 2, 0)).toBe('CODECO');
    expect(el(segs.find((s) => s.tag === 'EQD'), 2)).toBe(c1);
    expect(el(segs.find((s) => s.tag === 'TDT'), 8, 0)).toBe('AD 7781');
  });

  it('lists the EDI message log, with raw text on the detail', async () => {
    const edi = await t.as(['tos:edi']);
    const list = (await expectOk(edi.get('/v1/edi/messages'))).body;
    const statuses = new Set(list.map((m: any) => m.status));
    expect(statuses).toEqual(new Set(['ACCEPTED', 'REJECTED', 'GENERATED']));
    expect(list[0].raw).toBeUndefined();
    const one = (await expectOk(edi.get(`/v1/edi/messages/${list[0].id}`))).body;
    expect(one.raw).toContain('UN');
  });
});
