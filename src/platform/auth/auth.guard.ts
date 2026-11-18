import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { decodeJwt, jwtVerify, JWTPayload } from 'jose';
import { APP_CONFIG, AppConfig } from '../config';
import { RequestContext, ROLES } from '../context';
import { DatabaseService } from '../db/database.service';
import { ApiError } from '../errors';
import { IS_PUBLIC, REQUIRED_ROLES, REQUIRES_FACILITY } from './decorators';
import { KeyResolver } from './key-resolver';

/**
 * Global guard: verifies the OIDC/OAuth 2.0 bearer token, binds the caller to a tenant
 * (one IdP realm/issuer per tenant), checks roles and facility scope.
 *
 * Expected claims:
 *  - iss: tenant's issuer (registered in tenants.oidc_issuer) or the platform issuer
 *  - roles: string[]  or  realm_access.roles (Keycloak)
 *  - facilities?: string[] facility codes the caller may use (absent = all)
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly keys: KeyResolver,
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw ApiError.unauthorized('Missing bearer token');
    const token = header.slice(7);

    let unverified: JWTPayload;
    try {
      unverified = decodeJwt(token);
    } catch {
      throw ApiError.unauthorized('Malformed token');
    }
    const issuer = unverified.iss;
    if (!issuer) throw ApiError.unauthorized('Token has no issuer');

    const isPlatform = !!this.config.platformIssuer && issuer === this.config.platformIssuer;
    if (!isPlatform && this.config.trustedIssuerPrefixes.length > 0 &&
        !this.config.trustedIssuerPrefixes.some((p) => issuer.startsWith(p))) {
      throw ApiError.unauthorized('Untrusted issuer');
    }

    let tenant: { id: string; code: string; status: string } | undefined;
    if (!isPlatform) {
      tenant = await this.db.platformTx((tx) =>
        tx.one('SELECT id, code, status FROM tenants WHERE oidc_issuer = $1', [issuer]),
      );
      if (!tenant) throw ApiError.unauthorized('Unknown issuer');
      if (tenant.status !== 'ACTIVE') throw ApiError.forbidden('Tenant is suspended');
    }

    let payload: JWTPayload;
    try {
      const keySet = await this.keys.forIssuer(issuer);
      ({ payload } = await jwtVerify(token, keySet, {
        issuer,
        audience: this.config.oidcAudience,
        clockTolerance: 30,
      }));
    } catch {
      throw ApiError.unauthorized('Invalid token');
    }

    const roles = extractRoles(payload);
    const facilities = Array.isArray(payload['facilities']) ? (payload['facilities'] as string[]) : undefined;
    const facilityCode = (req.headers['x-facility'] as string | undefined)?.trim() || undefined;

    const ctx: RequestContext = {
      subject: String(payload.sub ?? 'unknown'),
      tenantId: tenant?.id,
      tenantCode: tenant?.code,
      roles,
      allowedFacilities: facilities,
      facilityCode,
      isPlatformAdmin: isPlatform && roles.includes(ROLES.platformAdmin),
    };

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES, targets);
    if (required?.length && !hasAnyRole(ctx, required)) throw ApiError.forbidden('Missing role');

    if (this.reflector.getAllAndOverride<boolean>(REQUIRES_FACILITY, targets)) {
      if (!ctx.facilityCode) throw ApiError.invalid('X-Facility header is required');
      if (ctx.allowedFacilities && !ctx.allowedFacilities.includes(ctx.facilityCode)) {
        throw ApiError.forbidden(`No access to facility ${ctx.facilityCode}`);
      }
    }

    req.ctx = ctx;
    return true;
  }
}

function extractRoles(p: JWTPayload): string[] {
  const direct = Array.isArray(p['roles']) ? (p['roles'] as string[]) : [];
  const realm = (p['realm_access'] as { roles?: string[] } | undefined)?.roles ?? [];
  return [...new Set([...direct, ...realm])];
}

export function hasAnyRole(ctx: RequestContext, required: string[]): boolean {
  if (required.includes(ROLES.platformAdmin)) return ctx.isPlatformAdmin;
  if (!ctx.tenantId) return false;
  if (ctx.roles.includes(ROLES.admin)) return true;
  return required.some((r) => ctx.roles.includes(r));
}
