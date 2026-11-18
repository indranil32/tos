import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../platform/context';
import { Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';
import { FacilityRow } from '../platform/facility';
import { isoDateTime } from '../platform/validation';

/** SOLAS chapter VI regulation 2: verified gross mass of packed containers. */
export const VgmBody = z.object({
  vgmKg: z.number().positive().max(60_000),
  method: z.enum(['SM1', 'SM2']).optional(),
  verifiedBy: z.string().max(140).optional(),
  verifiedAt: isoDateTime.optional(),
});
export type VgmInput = z.infer<typeof VgmBody>;

@Injectable()
export class VgmService {
  constructor(private readonly events: EventsService) {}

  /** Record VGM for an active unit, by id or by reference. API twin of VERMAS. */
  async set(tx: Tx, ctx: RequestContext, facility: FacilityRow, unit: { id?: string; ref?: string }, v: VgmInput) {
    const row = await tx.one<{ id: string; unit_ref: string; cargo_kind: string; state: string }>(
      `SELECT id, unit_ref, cargo_kind, state FROM units
        WHERE facility_id = $1 AND state <> 'DEPARTED' AND (id = $2::uuid OR unit_ref = $3) FOR UPDATE`,
      [facility.id, unit.id ?? null, unit.ref ?? null],
    );
    if (!row) throw ApiError.notFound(`Active unit ${unit.ref ?? unit.id}`);
    if (row.cargo_kind !== 'CONTAINER') throw ApiError.invalid('VGM applies to containers');
    if (row.state === 'LOADED') throw ApiError.conflict('already_loaded', `${row.unit_ref} is already loaded`);
    const at = v.verifiedAt ?? new Date().toISOString();
    await tx.exec(
      `UPDATE units SET vgm_kg = $2, vgm_method = $3, vgm_verified_by = $4, vgm_at = $5 WHERE id = $1`,
      [row.id, v.vgmKg, v.method ?? null, v.verifiedBy ?? null, at],
    );
    await this.events.emit(tx, ctx, {
      type: 'unit.vgm-set', aggregateType: 'unit', aggregateId: row.id, facilityId: facility.id,
      payload: { unitRef: row.unit_ref, vgmKg: v.vgmKg, method: v.method ?? null, verifiedBy: v.verifiedBy ?? null, verifiedAt: at },
    });
    return { unitId: row.id, unitRef: row.unit_ref, vgmKg: v.vgmKg, method: v.method ?? null, verifiedAt: at };
  }
}
