import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, JWK, SignJWT } from 'jose';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { iso6346CheckDigit } from '../../src/inventory/standards';
import { KeyResolver } from '../../src/platform/auth/key-resolver';

export const PLATFORM_ISSUER = 'https://id.test/realms/platform';
export const issuerFor = (tenantCode: string) => `https://id.test/realms/${tenantCode}`;

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
const keys = new Map<string, { pair: KeyPair; jwk: JWK }>();

async function keyFor(issuer: string) {
  let k = keys.get(issuer);
  if (!k) {
    const pair = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    k = { pair, jwk };
    keys.set(issuer, k);
  }
  return k;
}

/** Stands in for OIDC discovery: every test issuer gets its own signing key. */
class TestKeyResolver {
  async forIssuer(issuer: string) {
    const k = await keyFor(issuer);
    return createLocalJWKSet({ keys: [k.jwk] });
  }
}

export interface TokenOptions {
  issuer: string;
  sub?: string;
  roles?: string[];
  facilities?: string[];
  expiresIn?: string;
  /** Sign with another issuer's key (forgery test). */
  signAs?: string;
}

export async function token(o: TokenOptions): Promise<string> {
  const k = await keyFor(o.signAs ?? o.issuer);
  const claims: Record<string, unknown> = { realm_access: { roles: o.roles ?? [] } };
  if (o.facilities) claims.facilities = o.facilities;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(o.issuer)
    .setSubject(o.sub ?? 'user-1')
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '10m')
    .sign(k.pair.privateKey);
}

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KeyResolver)
    .useValue(new TestKeyResolver())
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}

export const uniq = () => Math.random().toString(36).slice(2, 8);

/** Valid ISO 6346 container number for an owner prefix (e.g. MSCU) and serial. */
export function container(prefix: string, serial: number): string {
  const first10 = `${prefix}${String(serial).padStart(6, '0')}`;
  return `${first10}${iso6346CheckDigit(first10)}`;
}

/** API client bound to a token and (optionally) a facility. */
export function client(app: INestApplication, bearer: string, facility?: string) {
  const http = request(app.getHttpServer());
  const withHeaders = (r: request.Test) => {
    r.set('Authorization', `Bearer ${bearer}`);
    if (facility) r.set('X-Facility', facility);
    return r;
  };
  return {
    get: (url: string) => withHeaders(http.get(url)),
    post: (url: string, body?: unknown) => withHeaders(http.post(url)).send(body as object),
    put: (url: string, body?: unknown) => withHeaders(http.put(url)).send(body as object),
    postText: (url: string, text: string) => withHeaders(http.post(url)).set('Content-Type', 'application/edifact').send(text),
  };
}

/**
 * Provision a tenant with a facility, yard, container block, laydown block and a line operator.
 * Returns admin/operator clients for it.
 */
export async function provisionTenant(app: INestApplication, opts: { unlocode?: string } = {}) {
  const code = `t-${uniq()}`;
  const platform = client(app, await token({ issuer: PLATFORM_ISSUER, roles: ['platform:admin'] }));
  const t = await platform.post('/v1/platform/tenants', { code, name: `Tenant ${code}`, oidcIssuer: issuerFor(code) });
  if (t.status !== 201) throw new Error(`tenant: ${t.status} ${t.text}`);

  const adminToken = await token({ issuer: issuerFor(code), roles: ['tos:admin'] });
  const admin = client(app, adminToken);
  const facility = 'MPT1';
  await expectOk(admin.post('/v1/complexes', { code: 'CPLX', name: 'Port complex' }));
  await expectOk(admin.post('/v1/facilities', {
    complexCode: 'CPLX', code: facility, name: 'Multipurpose Terminal 1', unlocode: opts.unlocode ?? 'AEKHL', currency: 'AED', smdgCode: 'KHLMPT',
  }));
  await expectOk(admin.post('/v1/yards', { facilityCode: facility, code: 'Y1', name: 'Main yard' }));
  await expectOk(admin.post('/v1/yard-blocks', { facilityCode: facility, yardCode: 'Y1', code: 'A1', blockType: 'CONTAINER_STACK', bays: 2, rows: 2, tiers: 2 }));
  await expectOk(admin.post('/v1/yard-blocks', { facilityCode: facility, yardCode: 'Y1', code: 'L1', blockType: 'LAYDOWN', capacity: 50 }));
  await expectOk(admin.post('/v1/partners', { code: 'MSC', name: 'Line MSC', roles: ['LINE_OPERATOR', 'CUSTOMER'] }));
  return {
    code,
    facility,
    issuer: issuerFor(code),
    adminToken,
    admin: client(app, adminToken, facility),
    as: async (roles: string[], facilities?: string[]) =>
      client(app, await token({ issuer: issuerFor(code), roles, facilities, sub: roles.join('+') }), facility),
  };
}

export async function expectOk(r: request.Test | Promise<request.Response>) {
  const res = await r;
  if (res.status >= 300) throw new Error(`${res.status}: ${res.text}`);
  return res;
}
