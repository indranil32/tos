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
  kinds: z.array(z.enum(['SEAPORT', 'DRY_PORT', 'DEPOT', 'CFS'])).min(1).default(['SEAPORT']),
});
const YardBody = z.object({ facilityCode: code, code, name: z.string().min(1) });
const BlockBody = z.object({
  facilityCode: code,
  yardCode: code,
  code,
  blockType: z.enum(['CONTAINER_STACK', 'LAYDOWN', 'RORO_LANE', 'TANK', 'WAREHOUSE']),
  bays: z.number().int().positive().default(1),
  rows: z.number().int().positive().default(1),
  tiers: z.number().int().positive().default(1),
  capacity: z.number().positive().optional(),
  capacityUnit: z.enum(['SLOTS', 'M2', 'LANE_M', 'VEHICLES', 'M3', 'PALLETS']).optional(),
  equipmentKind: z.string().max(20).optional(),
  allowedSizes: z.array(z.enum(['20', '40', '45'])).min(1).default(['20', '40', '45']),
  maxStackKg: z.number().int().positive().optional(),
  reeferPlugs: z.number().int().min(0).default(0),
  dgClasses: z.array(z.string().regex(/^[1-9](\.[1-6])?$/, 'IMDG class, e.g. 3 or 2.1')).default([]),
  map: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), angle: z.number().default(0) }).optional(),
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
        `INSERT INTO facilities (tenant_id, complex_id, code, name, facility_type, unlocode, smdg_code, timezone, currency, kinds)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, code, name, facility_type AS "facilityType", unlocode, smdg_code AS "smdgCode", timezone, currency, kinds`,
        [c.id, b.code, b.name, b.facilityType, b.unlocode ?? null, b.smdgCode ?? null, b.timezone, b.currency, b.kinds],
      );
    });
  }

  @Get('facilities')
  listFacilities(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, (tx) =>
      tx.many(
        `SELECT f.id, f.code, f.name, f.facility_type AS "facilityType", f.kinds, f.unlocode, c.code AS "complexCode", f.currency, f.timezone
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
        `INSERT INTO yard_blocks (tenant_id, yard_id, code, block_type, bays, rows_count, tiers, capacity, capacity_unit, equipment_kind,
                                  allowed_sizes, max_stack_kg, reefer_plugs, dg_classes, map_x, map_y, map_w, map_h, map_angle)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id, code, block_type AS "blockType", bays, rows_count AS rows, tiers, capacity, capacity_unit AS "capacityUnit",
                   equipment_kind AS "equipmentKind", allowed_sizes AS "allowedSizes", max_stack_kg AS "maxStackKg",
                   reefer_plugs AS "reeferPlugs", dg_classes AS "dgClasses"`,
        [y.id, b.code, b.blockType, b.bays, b.rows, b.tiers, b.capacity ?? null, b.capacityUnit ?? defaultUnit(b.blockType), b.equipmentKind ?? null,
         b.allowedSizes, b.maxStackKg ?? null, b.reeferPlugs, b.dgClasses, b.map?.x ?? null, b.map?.y ?? null, b.map?.w ?? null, b.map?.h ?? null, b.map?.angle ?? 0],
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

function defaultUnit(blockType: string): string {
  return { CONTAINER_STACK: 'SLOTS', LAYDOWN: 'M2', RORO_LANE: 'VEHICLES', TANK: 'M3', WAREHOUSE: 'PALLETS' }[blockType] ?? 'SLOTS';
}

export function assertTenant(ctx: RequestContext) {
  if (!ctx.tenantId) throw ApiError.forbidden('Tenant token required');
}
