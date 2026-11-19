import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService } from '../platform/db/database.service';
import { currentFacility } from '../platform/facility';
import { currency, parse } from '../platform/validation';
import { BillingService } from './billing.service';

const TariffBody = z.object({
  chargeCode: z.string().min(1).max(30),
  description: z.string().min(1),
  cargoKind: z.enum(['CONTAINER', 'BREAKBULK', 'VEHICLE', 'LIQUID']),
  triggerEvent: z.enum(['unit.discharged', 'unit.loaded', 'unit.gated-in', 'unit.gated-out', 'storage']),
  basis: z.enum(['PER_UNIT', 'PER_TEU', 'PER_TONNE', 'PER_M3', 'PER_DAY']),
  rate: z.number().nonnegative(),
  currency,
  freeDays: z.number().int().nonnegative().default(0),
  customer: z.string().optional(),
  allFacilities: z.boolean().default(false),
  validFrom: z.string().date().optional(),
  validTo: z.string().date().optional(),
});

@Controller('v1')
@FacilityScoped()
export class BillingController {
  constructor(private readonly db: DatabaseService, private readonly billing: BillingService) {}

  @Post('tariffs')
  @Roles(ROLES.billing)
  createTariff(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(TariffBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const customer = b.customer ? await tx.must('SELECT id FROM partners WHERE code = $1', [b.customer], `Customer ${b.customer}`) : null;
      return tx.one(
        `INSERT INTO tariffs (tenant_id, facility_id, customer_id, charge_code, description, cargo_kind, trigger_event, basis,
                              rate, currency, free_days, valid_from, valid_to)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($11::date, current_date), $12)
         RETURNING id, charge_code AS "chargeCode", description, cargo_kind AS "cargoKind", trigger_event AS "triggerEvent",
                   basis, rate, currency, free_days AS "freeDays", valid_from AS "validFrom", valid_to AS "validTo"`,
        [b.allFacilities ? null : f.id, customer?.id ?? null, b.chargeCode, b.description, b.cargoKind, b.triggerEvent, b.basis,
         b.rate, b.currency, b.freeDays, b.validFrom ?? null, b.validTo ?? null],
      );
    });
  }

  @Get('tariffs')
  listTariffs(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `SELECT t.id, t.charge_code AS "chargeCode", t.description, t.cargo_kind AS "cargoKind", t.trigger_event AS "triggerEvent",
                t.basis, t.rate, t.currency, t.free_days AS "freeDays", p.code AS customer, (t.facility_id IS NULL) AS "allFacilities"
           FROM tariffs t LEFT JOIN partners p ON p.id = t.customer_id
          WHERE t.facility_id = $1 OR t.facility_id IS NULL ORDER BY t.charge_code`,
        [f.id],
      );
    });
  }

  @Get('charges')
  @Roles(ROLES.billing)
  charges(@Ctx() ctx: RequestContext, @Query('customer') customer?: string, @Query('uninvoiced') uninvoiced?: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `SELECT c.id, p.code AS customer, u.unit_ref AS "unitRef", c.charge_code AS "chargeCode", c.quantity, c.rate, c.amount,
                c.currency, c.event_type AS "eventType", c.event_at AS "eventAt", c.invoice_id AS "invoiceId"
           FROM charges c JOIN partners p ON p.id = c.customer_id JOIN units u ON u.id = c.unit_id
          WHERE c.facility_id = $1 AND ($2::text IS NULL OR p.code = $2) AND ($3::boolean IS NOT TRUE OR c.invoice_id IS NULL)
          ORDER BY c.event_at`,
        [f.id, customer ?? null, uninvoiced === 'true'],
      );
    });
  }

  /** Issue invoices for a customer. API twin of INVOIC; the ERP connector consumes invoice.issued. */
  @Post('invoices')
  @Roles(ROLES.billing)
  invoice(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(z.object({ customer: z.string().min(1) }), body);
    return this.db.tx(ctx, async (tx) => ({ invoices: await this.billing.invoice(tx, ctx, await currentFacility(tx, ctx), b.customer) }));
  }

  @Get('invoices')
  @Roles(ROLES.billing)
  listInvoices(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `SELECT i.id, i.invoice_no AS "invoiceNo", p.code AS customer, p.name AS "customerName", i.currency, i.total, i.status,
                i.erp_export_status AS "erpExportStatus", i.issued_at AS "issuedAt",
                (SELECT count(*)::int FROM charges c WHERE c.invoice_id = i.id) AS lines
           FROM invoices i JOIN partners p ON p.id = i.customer_id WHERE i.facility_id = $1 ORDER BY i.issued_at DESC LIMIT 5000`,
        [f.id],
      );
    });
  }

  @Get('invoices/:id')
  @Roles(ROLES.billing)
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => this.billing.get(tx, await currentFacility(tx, ctx), id));
  }
}
