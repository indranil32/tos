import { Injectable, OnModuleInit } from '@nestjs/common';
import { teuFromIsoType } from '../inventory/standards';
import { RequestContext } from '../platform/context';
import { Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { DomainEvent, EventsService } from '../platform/events/events.service';
import { FacilityRow } from '../platform/facility';

interface TariffRow {
  id: string;
  charge_code: string;
  description: string;
  basis: string;
  rate: string;
  currency: string;
  free_days: number;
}

interface UnitRow {
  id: string;
  facility_id: string;
  cargo_kind: string;
  iso_type: string | null;
  gross_weight_kg: string | null;
  quantity: string;
  quantity_uom: string;
  line_operator_id: string | null;
  time_in: Date | null;
  time_out: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * Event-driven billing: charges accrue in the same transaction as the operational event,
 * so a move can never happen without its charge. Invoices are built from uninvoiced charges.
 * Tariff precedence: customer contract > standard; facility-specific > tenant-wide.
 */
@Injectable()
export class BillingService implements OnModuleInit {
  constructor(private readonly events: EventsService) {}

  onModuleInit() {
    for (const trigger of ['unit.discharged', 'unit.loaded', 'unit.gated-in']) {
      this.events.on(trigger, (tx, _ctx, e) => this.accrue(tx, e, trigger));
    }
    this.events.on('unit.gated-out', async (tx, _ctx, e) => {
      await this.accrue(tx, e, 'unit.gated-out');
      await this.accrue(tx, e, 'storage');
    });
  }

  private async accrue(tx: Tx, event: DomainEvent, trigger: string) {
    const unit = await tx.one<UnitRow>(
      `SELECT id, facility_id, cargo_kind, iso_type, gross_weight_kg, quantity, quantity_uom, line_operator_id, time_in, time_out
         FROM units WHERE id = $1`,
      [event.aggregateId],
    );
    if (!unit || !unit.line_operator_id) return; // no bill-to party: nothing to accrue

    const eventAt = new Date(event.occurredAt ?? Date.now());
    const tariffs = await tx.many<TariffRow>(
      `SELECT DISTINCT ON (charge_code) id, charge_code, description, basis, rate, currency, free_days
         FROM tariffs
        WHERE trigger_event = $1 AND cargo_kind = $2
          AND (facility_id = $3 OR facility_id IS NULL)
          AND (customer_id = $4 OR customer_id IS NULL)
          AND valid_from <= $5::date AND (valid_to IS NULL OR valid_to >= $5::date)
        ORDER BY charge_code, (customer_id IS NULL), (facility_id IS NULL), valid_from DESC`,
      [trigger, unit.cargo_kind, unit.facility_id, unit.line_operator_id, eventAt.toISOString()],
    );

    for (const t of tariffs) {
      const quantity = this.quantity(t, unit);
      if (quantity <= 0) continue;
      await tx.exec(
        `INSERT INTO charges (tenant_id, facility_id, unit_id, customer_id, tariff_id, charge_code, description,
                              quantity, rate, amount, currency, event_type, event_at)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8, round($7::numeric * $8::numeric, 2), $9,$10,$11)`,
        [unit.facility_id, unit.id, unit.line_operator_id, t.id, t.charge_code, t.description, quantity, t.rate, t.currency, trigger, eventAt],
      );
    }
  }

  private quantity(t: TariffRow, u: UnitRow): number {
    switch (t.basis) {
      case 'PER_UNIT':
        return 1;
      case 'PER_TEU':
        return teuFromIsoType(u.iso_type);
      case 'PER_TONNE':
        return u.quantity_uom === 'MT' ? Number(u.quantity) : Number(u.gross_weight_kg ?? 0) / 1000;
      case 'PER_M3':
        return u.quantity_uom === 'M3' ? Number(u.quantity) : 0;
      case 'PER_DAY': {
        if (!u.time_in || !u.time_out) return 0;
        const days = Math.ceil((u.time_out.getTime() - u.time_in.getTime()) / DAY_MS);
        return Math.max(0, days - t.free_days);
      }
      default:
        return 0;
    }
  }

  /** Build one invoice per currency from the customer's uninvoiced charges at this facility. */
  async invoice(tx: Tx, ctx: RequestContext, facility: FacilityRow, customerCode: string) {
    const customer = await tx.must<{ id: string; code: string; erp_customer_ref: string | null }>(
      'SELECT id, code, erp_customer_ref FROM partners WHERE code = $1',
      [customerCode],
      `Customer ${customerCode}`,
    );
    const groups = await tx.many<{ currency: string; total: string; n: number }>(
      `SELECT currency, sum(amount) AS total, count(*)::int AS n FROM charges
        WHERE facility_id = $1 AND customer_id = $2 AND invoice_id IS NULL GROUP BY currency ORDER BY currency`,
      [facility.id, customer.id],
    );
    if (!groups.length) throw ApiError.conflict('nothing_to_invoice', `No uninvoiced charges for ${customerCode}`);

    const invoices = [];
    for (const g of groups) {
      const year = new Date().getUTCFullYear();
      const seq = await tx.one<{ value: string }>(
        `INSERT INTO counters (tenant_id, name, value) VALUES (current_tenant(), $1, 1)
         ON CONFLICT (tenant_id, name) DO UPDATE SET value = counters.value + 1 RETURNING value`,
        [`invoice:${facility.code}:${year}`],
      );
      const invoiceNo = `${facility.code}-${year}-${String(seq!.value).padStart(6, '0')}`;
      const inv = await tx.one<{ id: string }>(
        `INSERT INTO invoices (tenant_id, facility_id, invoice_no, customer_id, currency, total)
         VALUES (current_tenant(), $1,$2,$3,$4,$5) RETURNING id`,
        [facility.id, invoiceNo, customer.id, g.currency, g.total],
      );
      await tx.exec(
        `UPDATE charges SET invoice_id = $1 WHERE facility_id = $2 AND customer_id = $3 AND currency = $4 AND invoice_id IS NULL`,
        [inv!.id, facility.id, customer.id, g.currency],
      );
      await this.events.emit(tx, ctx, {
        type: 'invoice.issued', aggregateType: 'invoice', aggregateId: inv!.id, facilityId: facility.id,
        payload: { invoiceNo, customer: customer.code, erpCustomerRef: customer.erp_customer_ref, currency: g.currency, total: g.total, lines: g.n },
      });
      invoices.push(await this.get(tx, facility, inv!.id));
    }
    return invoices;
  }

  async get(tx: Tx, facility: FacilityRow, id: string) {
    const inv = await tx.must(
      `SELECT i.id, i.invoice_no AS "invoiceNo", p.code AS customer, i.currency, i.total, i.status,
              i.erp_export_status AS "erpExportStatus", i.issued_at AS "issuedAt"
         FROM invoices i JOIN partners p ON p.id = i.customer_id WHERE i.id = $1 AND i.facility_id = $2`,
      [id, facility.id],
      'Invoice',
    );
    const lines = await tx.many(
      `SELECT c.charge_code AS "chargeCode", c.description, u.unit_ref AS "unitRef", c.quantity, c.rate, c.amount, c.event_type AS "eventType", c.event_at AS "eventAt"
         FROM charges c JOIN units u ON u.id = c.unit_id WHERE c.invoice_id = $1 ORDER BY u.unit_ref, c.charge_code`,
      [id],
    );
    return { ...inv, lines };
  }
}
