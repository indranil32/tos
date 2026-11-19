import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService, Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { currentFacility, FacilityRow } from '../platform/facility';
import { VgmService } from '../inventory/vgm.service';
import { VesselService } from '../vessel/vessel.service';
import { parseEdifact } from './edifact';
import { buildCoarri, buildCodeco, mapCoprar, mapVermas, splitInterchange } from './messages';

/**
 * EDI gateway. Every inbound message is mapped onto the same service the REST API uses,
 * and every outbound message is generated from the same data the REST API returns.
 * Supported now: COPRAR in; COARRI and CODECO out. See docs/edi-api-catalogue.md for the full list.
 */
@Controller('v1/edi')
@FacilityScoped()
export class EdiController {
  constructor(private readonly db: DatabaseService, private readonly vessels: VesselService, private readonly vgm: VgmService) {}

  @Post('inbound')
  @Roles(ROLES.edi)
  async inbound(@Ctx() ctx: RequestContext, @Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    if (typeof raw !== 'string' || !raw.trim()) throw ApiError.invalid('Send the EDIFACT interchange as text/plain or application/edifact');
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      await tx.exec('SAVEPOINT edi');
      let messageType = 'UNKNOWN';
      let ref: string | undefined;
      let partner: string | undefined;
      try {
        const ic = splitInterchange(parseEdifact(raw));
        messageType = ic.messageType;
        ref = ic.ref;
        partner = ic.sender;
        const result = await this.dispatch(tx, ctx, f, ic.messageType, ic.segments);
        await this.log(tx, f, 'IN', messageType, ref, partner, raw, 'ACCEPTED', null);
        return { status: 'ACCEPTED', messageType, interchangeRef: ref ?? null, result };
      } catch (e) {
        await tx.exec('ROLLBACK TO SAVEPOINT edi');
        const err = e as Error & { details?: unknown };
        await this.log(tx, f, 'IN', messageType, ref, partner, raw, 'REJECTED', err.message);
        res.status(e instanceof ApiError && e.status !== 422 ? e.status : 422);
        // APERAK-style answer: the partner learns exactly which message and why.
        return { status: 'REJECTED', messageType, interchangeRef: ref ?? null, error: err.message, errors: err.details ?? undefined };
      }
    });
  }

  @Get('messages')
  @Roles(ROLES.edi, ROLES.planner, ROLES.viewer)
  messages(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `SELECT id, direction, message_type AS "messageType", interchange_ref AS "interchangeRef", partner_code AS partner,
                status, error, length(raw) AS bytes, created_at AS "createdAt"
           FROM edi_messages WHERE facility_id = $1 ORDER BY created_at DESC LIMIT 5000`,
        [f.id],
      );
    });
  }

  @Get('messages/:id')
  @Roles(ROLES.edi, ROLES.planner, ROLES.viewer)
  message(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.must(
        `SELECT id, direction, message_type AS "messageType", interchange_ref AS "interchangeRef", partner_code AS partner,
                status, error, raw, created_at AS "createdAt" FROM edi_messages WHERE id = $1 AND facility_id = $2`,
        [id, f.id],
        'EDI message',
      );
    });
  }

  @Get('outbound/coarri/:visitId')
  @Roles(ROLES.edi, ROLES.planner)
  @Header('Content-Type', 'application/edifact')
  coarri(@Ctx() ctx: RequestContext, @Param('visitId', ParseUUIDPipe) visitId: string, @Query('kind') kindParam?: string) {
    const kind = (kindParam ?? 'DISCHARGE').toUpperCase();
    if (kind !== 'DISCHARGE' && kind !== 'LOAD') throw ApiError.invalid('kind must be DISCHARGE or LOAD');
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const v = await tx.must(
        `SELECT v.id, v.visit_ref, coalesce(v.voyage_in, v.visit_ref) AS voyage, coalesce(v.voyage_out, v.voyage_in, v.visit_ref) AS voyage_out, s.imo, s.name, p.code AS line
           FROM vessel_visits v JOIN vessels s ON s.id = v.vessel_id LEFT JOIN partners p ON p.id = v.line_operator_id
          WHERE v.id = $1 AND v.facility_id = $2`,
        [visitId, f.id],
        'Vessel visit',
      );
      const moves = await tx.many(
        `SELECT u.unit_ref, u.iso_type, u.freight_kind, coalesce(u.vgm_kg, u.gross_weight_kg) AS gross_weight_kg, w.completed_at,
                CASE WHEN w.move_kind = 'LOAD' THEN w.to_position END AS stow_position
           FROM work_instructions w JOIN units u ON u.id = w.unit_id
          WHERE w.visit_id = $1 AND w.move_kind = $2 AND w.status = 'COMPLETED' AND u.cargo_kind = 'CONTAINER'
          ORDER BY w.completed_at, u.unit_ref`,
        [visitId, kind],
      );
      const ref = await this.nextRef(tx, f);
      const text = buildCoarri(
        { sender: f.smdg_code ?? f.code, recipient: v.line ?? 'UNKNOWN', ref, at: new Date() },
        { voyage: kind === 'LOAD' ? v.voyage_out : v.voyage, imo: v.imo, vesselName: v.name, lineOperator: v.line ?? undefined, unlocode: f.unlocode },
        kind,
        moves.map((m) => ({
          unitRef: m.unit_ref, isoType: m.iso_type, freightKind: m.freight_kind, grossWeightKg: m.gross_weight_kg,
          completedAt: m.completed_at, moveKind: kind, stowPosition: m.stow_position === 'VESSEL' ? null : m.stow_position,
        })),
      );
      await this.log(tx, f, 'OUT', 'COARRI', ref, v.line ?? undefined, text, 'GENERATED', null);
      return text;
    });
  }

  @Get('outbound/codeco/:gateTransactionId')
  @Roles(ROLES.edi, ROLES.gate)
  @Header('Content-Type', 'application/edifact')
  codeco(@Ctx() ctx: RequestContext, @Param('gateTransactionId', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const g = await tx.must(
        `SELECT g.direction, g.unit_ref, g.truck_plate, g.created_at, u.iso_type, u.freight_kind, p.code AS line
           FROM gate_transactions g JOIN units u ON u.id = g.unit_id LEFT JOIN partners p ON p.id = u.line_operator_id
          WHERE g.id = $1 AND g.facility_id = $2 AND g.status = 'COMPLETED'`,
        [id, f.id],
        'Completed gate transaction',
      );
      const ref = await this.nextRef(tx, f);
      const text = buildCodeco(
        { sender: f.smdg_code ?? f.code, recipient: g.line ?? 'UNKNOWN', ref, at: new Date() },
        { direction: g.direction, unitRef: g.unit_ref, isoType: g.iso_type, freightKind: g.freight_kind, truckPlate: g.truck_plate, at: g.created_at, unlocode: f.unlocode },
      );
      await this.log(tx, f, 'OUT', 'CODECO', ref, g.line ?? undefined, text, 'GENERATED', null);
      return text;
    });
  }

  private async dispatch(tx: Tx, ctx: RequestContext, f: FacilityRow, type: string, segs: ReturnType<typeof splitInterchange>['segments']) {
    switch (type) {
      case 'COPRAR': {
        const c = mapCoprar(segs);
        const vesselCol = c.vesselIdType === 'CALL_SIGN' ? 's.call_sign' : 's.imo';
        const visit = await tx.one<{ id: string; voyage_in: string | null }>(
          `SELECT v.id, v.voyage_in FROM vessel_visits v JOIN vessels s ON s.id = v.vessel_id
            WHERE v.facility_id = $1 AND (v.voyage_in = $2 OR v.voyage_out = $2) AND ($3::text IS NULL OR ${vesselCol} = $3)
              AND v.phase NOT IN ('DEPARTED','CANCELLED')`,
          [f.id, c.voyage, c.vesselId ?? null],
        );
        if (!visit) throw ApiError.notFound(`Open vessel visit for voyage ${c.voyage}`);
        const items = c.items.map(({ _pol, _pod, ...item }) => {
          let move: 'DISCHARGE' | 'LOAD';
          if (f.unlocode && _pod === f.unlocode) move = 'DISCHARGE';
          else if (f.unlocode && _pol === f.unlocode) move = 'LOAD';
          else move = visit.voyage_in === c.voyage ? 'DISCHARGE' : 'LOAD';
          return { ...item, move, pol: _pol, pod: _pod };
        });
        return this.vessels.applyLoadList(tx, ctx, f, visit.id, items);
      }
      case 'VERMAS': {
        const entries = mapVermas(segs);
        const results = [];
        for (const e of entries) {
          results.push(await this.vgm.set(tx, ctx, f, { ref: e.unitRef }, { vgmKg: e.vgmKg, method: e.method, verifiedBy: e.verifiedBy, verifiedAt: e.verifiedAt }));
        }
        return { vgmRecorded: results.length };
      }
      default:
        throw ApiError.invalid(`Message type ${type} is not supported yet`);
    }
  }

  private async nextRef(tx: Tx, f: FacilityRow): Promise<string> {
    const r = await tx.one<{ value: string }>(
      `INSERT INTO counters (tenant_id, name, value) VALUES (current_tenant(), $1, 1)
       ON CONFLICT (tenant_id, name) DO UPDATE SET value = counters.value + 1 RETURNING value`,
      [`edi:${f.code}`],
    );
    return `${f.code}${String(r!.value).padStart(8, '0')}`.slice(-14);
  }

  private log(tx: Tx, f: FacilityRow, dir: string, type: string, ref: string | undefined, partner: string | undefined, raw: string, status: string, error: string | null) {
    return tx.exec(
      `INSERT INTO edi_messages (tenant_id, facility_id, direction, message_type, interchange_ref, partner_code, raw, status, error)
       VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8)`,
      [f.id, dir, type, ref ?? null, partner ?? null, raw, status, error],
    );
  }
}
