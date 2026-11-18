import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { client, container, createApp, expectOk, issuerFor, PLATFORM_ISSUER, provisionTenant, token } from './support/harness';

describe('Multi-tenancy, identity and access', () => {
  let app: INestApplication;
  let a: Awaited<ReturnType<typeof provisionTenant>>;
  let b: Awaited<ReturnType<typeof provisionTenant>>;
  let unitId: string;

  beforeAll(async () => {
    app = await createApp();
    a = await provisionTenant(app);
    b = await provisionTenant(app);
    const planner = await a.as(['tos:planner']);
    await expectOk(planner.post('/v1/vessels', { imo: '9400001', name: 'ALPHA' }));
    const v = await expectOk(planner.post('/v1/visits', { visitRef: 'A-1', imo: '9400001', lineOperator: 'MSC', voyageIn: 'A1' }));
    await expectOk(planner.post(`/v1/visits/${v.body.id}/load-lists`, { items: [{ unitRef: container('TGHU', 777001), isoType: '22G1' }] }));
    unitId = (await planner.get(`/v1/units?ref=${container('TGHU', 777001)}`)).body[0].id;
  });
  afterAll(async () => app.close());

  it('rejects requests without a token, with an unknown issuer or a forged signature', async () => {
    const http = request(app.getHttpServer());
    expect((await http.get('/v1/tenant')).status).toBe(401);
    const unknown = await token({ issuer: 'https://id.test/realms/nobody', roles: ['tos:admin'] });
    expect((await http.get('/v1/tenant').set('Authorization', `Bearer ${unknown}`)).status).toBe(401);
    const untrusted = await token({ issuer: 'https://evil.example/realms/x', roles: ['tos:admin'] });
    expect((await http.get('/v1/tenant').set('Authorization', `Bearer ${untrusted}`)).status).toBe(401);
    const forged = await token({ issuer: a.issuer, roles: ['tos:admin'], signAs: b.issuer });
    expect((await http.get('/v1/tenant').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    const expired = await token({ issuer: a.issuer, roles: ['tos:admin'], expiresIn: '-5m' });
    expect((await http.get('/v1/tenant').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });

  it('keeps tenants apart through row-level security', async () => {
    // Tenant B has a facility with the same code; tenant A's unit must still be invisible to it.
    const bView = await b.as(['tos:viewer']);
    expect((await bView.get(`/v1/units/${unitId}`)).status).toBe(404);
    expect((await bView.get('/v1/units')).body).toHaveLength(0);
    const aView = await a.as(['tos:viewer']);
    expect((await aView.get(`/v1/units/${unitId}`)).status).toBe(200);
  });

  it('enforces roles (tos:admin implies all tenant roles)', async () => {
    const viewer = await a.as(['tos:viewer']);
    expect((await viewer.post('/v1/vessels', { imo: '9400002', name: 'BETA' })).status).toBe(403);
    expect((await a.admin.post('/v1/vessels', { imo: '9400002', name: 'BETA' })).status).toBe(201);
    const gate = await a.as(['tos:gate']);
    expect((await gate.post('/v1/invoices', { customer: 'MSC' })).status).toBe(403);
  });

  it('restricts users to the facilities in their token', async () => {
    const scoped = await a.as(['tos:viewer'], ['OTHER']);
    const r = await scoped.get('/v1/units');
    expect(r.status).toBe(403);
    const noHeader = client(app, await token({ issuer: a.issuer, roles: ['tos:viewer'] }));
    expect((await noHeader.get('/v1/units')).status).toBe(422);
  });

  it('only platform admins provision tenants, and tenant admins cannot', async () => {
    const tenantAdmin = client(app, a.adminToken);
    expect((await tenantAdmin.post('/v1/platform/tenants', { code: 'x-1', name: 'X', oidcIssuer: issuerFor('x-1') })).status).toBe(403);
    const platform = client(app, await token({ issuer: PLATFORM_ISSUER, roles: ['platform:admin'] }));
    const list = await expectOk(platform.get('/v1/platform/tenants'));
    expect(list.body.map((t: any) => t.code)).toEqual(expect.arrayContaining([a.code, b.code]));
    // A platform token carries no tenant, so it cannot read tenant data.
    expect((await platform.get('/v1/facilities')).status).toBe(403);
  });

  it('returns problem+json for validation errors', async () => {
    const r = await a.admin.post('/v1/partners', { code: 'bad code!', name: '', roles: [] });
    expect(r.status).toBe(422);
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(r.body.errors.length).toBeGreaterThan(0);
  });

  it('serves a public health check', async () => {
    expect((await request(app.getHttpServer()).get('/health')).body).toEqual({ status: 'ok' });
  });
});
