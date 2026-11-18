import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { code, currency, parse, unlocode } from '../platform/validation';

const TenantBody = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  name: z.string().min(1),
  oidcIssuer: z.string().url(),
  dataRegion: z.string().default('default'),
});

/** Platform operator: provision tenants (one IdP realm/issuer each). */
@Controller('v1/platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly db: DatabaseService) {}

  @Post()
  @Roles(ROLES.platformAdmin)
  create(@Body() body: unknown) {
    const b = parse(TenantBody, body);
    return this.db.platformTx((tx) =>
      tx.one(
        `INSERT INTO tenants (code, name, oidc_issuer, data_region) VALUES ($1,$2,$3,$4)
         RETURNING id, code, name, oidc_issuer AS "oidcIssuer", data_region AS "dataRegion", status`,
        [b.code, b.name, b.oidcIssuer, b.dataRegion],
      ),
    );
  }

  @Get()
  @Roles(ROLES.platformAdmin)
  list() {
    return this.db.platformTx((tx) =>
      tx.many('SELECT id, code, name, oidc_issuer AS "oidcIssuer", data_region AS "dataRegion", status FROM tenants ORDER BY code'),
    );
  }
}

const ComplexBody = z.object({ code, name: z.string().min(1) });
const FacilityBody = z.object({
  complexCode: code,
  code,
  name: z.string().min(1),
  facilityType: z.enum(['MULTIPURPOSE', 'CONTAINER', 'BREAKBULK', 'RORO', 'LIQUID_BULK']).default('MULTIPURPOSE'),
  unlocode: unlocode.optional(),
  smdgCode: z.string().max(10).optional(),
  timezone: z.string().default('UTC'),
  currency: currency.default('USD'),
});
const YardBody = z.object({ facilityCode: code, code, name: z.string().min(1) });
const BlockBody = z.object({
  facilityCode: code,
  yardCode: code,
  code,
  blockType: z.enum(['CONTAINER_STACK', 'LAYDOWN', 'RORO_LANE', 'TANK']),
  bays: z.number().int().positive().default(1),
  rows: z.number().int().positive().default(1),
  tiers: z.number().int().positive().default(1),
  capacity: z.number().positive().optional(),
});
const PartnerBody = z.object({
  code,
  name: z.string().min(1),
  roles: z.array(z.enum(['LINE_OPERATOR', 'AGENT', 'HAULIER', 'CONSIGNEE', 'CUSTOMER'])).min(1),
  isAeo: z.boolean().default(false),
  erpCustomerRef: z.string().optional(),
});

/** Tenant admin: the tenant -> complex -> facility -> yard -> block hierarchy and partners. */
@Controller('v1')
export class MasterDataController {
  constructor(private readonly db: DatabaseService) {}

  @Get('tenant')
  me(@Ctx() ctx: RequestContext) {
    return { tenantId: ctx.tenantId, tenantCode: ctx.tenantCode, subject: ctx.subject, roles: ctx.roles, facilities: ctx.allowedFacilities ?? 'ALL' };
  }

  @Post('complexes')
  @Roles(ROLES.admin)
  createComplex(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(ComplexBody, body);
    return this.db.tx(ctx, (tx) =>
      tx.one('INSERT INTO complexes (tenant_id, code, name) VALUES (current_tenant(), $1, $2) RETURNING id, code, name', [b.code, b.name]),
    );
  }

  @Post('facilities')
  @Roles(ROLES.admin)
  createFacility(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(FacilityBody, body);
    return this.db.tx(ctx, async (tx) => {
      const c = await tx.must('SELECT id FROM complexes WHERE code = $1', [b.complexCode], `Complex ${b.complexCode}`);
      return tx.one(
        `INSERT INTO facilities (tenant_id, complex_id, code, name, facility_type, unlocode, smdg_code, timezone, currency)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, code, name, facility_type AS "facilityType", unlocode, smdg_code AS "smdgCode", timezone, currency`,
        [c.id, b.code, b.name, b.facilityType, b.unlocode ?? null, b.smdgCode ?? null, b.timezone, b.currency],
      );
    });
  }

  @Get('facilities')
  listFacilities(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, (tx) =>
      tx.many(
        `SELECT f.id, f.code, f.name, f.facility_type AS "facilityType", f.unlocode, c.code AS "complexCode", f.currency
           FROM facilities f JOIN complexes c ON c.id = f.complex_id
          WHERE ($1::text[] IS NULL OR f.code = ANY($1)) ORDER BY c.code, f.code`,
        [ctx.allowedFacilities ?? null],
      ),
    );
  }

  @Post('yards')
  @Roles(ROLES.admin)
  createYard(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(YardBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await tx.must('SELECT id FROM facilities WHERE code = $1', [b.facilityCode], `Facility ${b.facilityCode}`);
      return tx.one(
        'INSERT INTO yards (tenant_id, facility_id, code, name) VALUES (current_tenant(), $1,$2,$3) RETURNING id, code, name',
        [f.id, b.code, b.name],
      );
    });
  }

  @Post('yard-blocks')
  @Roles(ROLES.admin)
  createBlock(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(BlockBody, body);
    return this.db.tx(ctx, async (tx) => {
      const y = await tx.must(
        'SELECT y.id FROM yards y JOIN facilities f ON f.id = y.facility_id WHERE f.code = $1 AND y.code = $2',
        [b.facilityCode, b.yardCode],
        `Yard ${b.facilityCode}/${b.yardCode}`,
      );
      return tx.one(
        `INSERT INTO yard_blocks (tenant_id, yard_id, code, block_type, bays, rows_count, tiers, capacity)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7)
         RETURNING id, code, block_type AS "blockType", bays, rows_count AS rows, tiers, capacity`,
        [y.id, b.code, b.blockType, b.bays, b.rows, b.tiers, b.capacity ?? null],
      );
    });
  }

  @Post('partners')
  @Roles(ROLES.admin)
  createPartner(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(PartnerBody, body);
    return this.db.tx(ctx, (tx) =>
      tx.one(
        `INSERT INTO partners (tenant_id, code, name, roles, is_aeo, erp_customer_ref)
         VALUES (current_tenant(), $1,$2,$3,$4,$5)
         RETURNING id, code, name, roles, is_aeo AS "isAeo", erp_customer_ref AS "erpCustomerRef"`,
        [b.code, b.name, b.roles, b.isAeo, b.erpCustomerRef ?? null],
      ),
    );
  }

  @Get('partners')
  listPartners(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, (tx) =>
      tx.many('SELECT id, code, name, roles, is_aeo AS "isAeo" FROM partners ORDER BY code'),
    );
  }
}

export function assertTenant(ctx: RequestContext) {
  if (!ctx.tenantId) throw ApiError.forbidden('Tenant token required');
}
