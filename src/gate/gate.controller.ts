import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { YardAllocator } from '../inventory/yard-allocator';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService, Tx } from '../platform/db/database.service';
import { EventsService } from '../platform/events/events.service';
import { currentFacility, FacilityRow } from '../platform/facility';
import { isoDateTime, parse } from '../platform/validation';

const GateBody = z.object({
  direction: z.enum(['IN', 'OUT']),
  unitRef: z.string().trim().toUpperCase(),
  truckPlate: z.string().max(20).optional(),
  haulier: z.string().optional(),
  at: isoDateTime.optional(),
});

/**
 * Truck gate. API twin of CODECO (gate in/out report).
 * A rejected visit is recorded (trouble-ticket lane) and returned with status REJECTED.
 */
@Controller('v1/gate/transactions')
@FacilityScoped()
export class GateController {
  constructor(private readonly db: DatabaseService, private readonly events: EventsService, private readonly yard: YardAllocator) {}

  @Post()
  @Roles(ROLES.gate)
  process(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(GateBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const haulier = b.haulier ? await tx.one<{ id: string }>('SELECT id FROM partners WHERE code = $1', [b.haulier]) : undefined;
      const unit = await tx.one<{ id: string; state: string; category: string; cargo_kind: string; iso_type: string | null; yard_position: string | null }>(
        `SELECT id, state, category, cargo_kind, iso_type, yard_position FROM units
          WHERE facility_id = $1 AND unit_ref = $2 AND state <> 'DEPARTED' FOR UPDATE`,
        [f.id, b.unitRef],
      );
      const at = b.at ?? new Date().toISOString();

      const reason = b.direction === 'OUT' ? await this.checkOut(tx, unit) : checkIn(unit);
      if (reason) return this.record(tx, f, b, unit?.id ?? null, haulier?.id ?? null, 'REJECTED', reason);

      let position: string | null = null;
      if (b.direction === 'OUT') {
        await tx.exec(`UPDATE units SET state = 'DEPARTED', time_out = $2, yard_position = NULL WHERE id = $1`, [unit!.id, at]);
      } else {
        const alloc = await this.yard.allocate(tx, f.id, unit!.cargo_kind);
        position = alloc.position;
        await tx.exec(
          `UPDATE units SET state = 'IN_YARD', time_in = $2, yard_block_id = $3, yard_position = $4 WHERE id = $1`,
          [unit!.id, at, alloc.blockId, alloc.position],
        );
      }
      const result = await this.record(tx, f, b, unit!.id, haulier?.id ?? null, 'COMPLETED', null);
      await this.events.emit(tx, ctx, {
        type: b.direction === 'OUT' ? 'unit.gated-out' : 'unit.gated-in',
        aggregateType: 'unit', aggregateId: unit!.id, facilityId: f.id, occurredAt: at,
        payload: {
          unitRef: b.unitRef, cargoKind: unit!.cargo_kind, isoType: unit!.iso_type, truckPlate: b.truckPlate ?? null,
          gateTransactionId: result.id, position: position ?? unit!.yard_position,
        },
      });
      return { ...result, position };
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.must(
        `SELECT id, direction, unit_ref AS "unitRef", truck_plate AS "truckPlate", status, reject_reason AS "rejectReason", created_at AS "createdAt"
           FROM gate_transactions WHERE id = $1 AND facility_id = $2`,
        [id, f.id],
        'Gate transaction',
      );
    });
  }

  private async checkOut(tx: Tx, unit: { id: string; state: string; category: string } | undefined): Promise<string | null> {
    if (!unit) return 'Unit not in terminal';
    if (unit.state !== 'IN_YARD') return `Unit is ${unit.state}`;
    if (!['IMPORT', 'STORAGE'].includes(unit.category)) return `Category ${unit.category} cannot leave by truck`;
    const holds = await tx.many<{ hold_type: string }>(
      'SELECT hold_type FROM unit_holds WHERE unit_id = $1 AND released_at IS NULL',
      [unit.id],
    );
    if (holds.length) return `Active holds: ${holds.map((h) => h.hold_type).join(', ')}`;
    return null;
  }

  private async record(tx: Tx, f: FacilityRow, b: z.infer<typeof GateBody>, unitId: string | null, haulierId: string | null, status: string, reason: string | null) {
    const row = await tx.one(
      `INSERT INTO gate_transactions (tenant_id, facility_id, direction, unit_id, unit_ref, truck_plate, haulier_id, status, reject_reason)
       VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, direction, unit_ref AS "unitRef", truck_plate AS "truckPlate", status, reject_reason AS "rejectReason", created_at AS "createdAt"`,
      [f.id, b.direction, unitId, b.unitRef, b.truckPlate ?? null, haulierId, status, reason],
    );
    return row!;
  }
}

function checkIn(unit: { state: string; category: string } | undefined): string | null {
  if (!unit) return 'No pre-advice (booking or load list) for this unit';
  if (unit.state !== 'ADVISED') return `Unit is ${unit.state}`;
  if (!['EXPORT', 'STORAGE'].includes(unit.category)) return `Category ${unit.category} is not expected at the gate`;
  return null;
}
