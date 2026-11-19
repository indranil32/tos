import { Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { Ctx, FacilityScoped, Roles } from "../platform/auth/decorators";
import { RequestContext, ROLES } from "../platform/context";
import { DatabaseService, Tx } from "../platform/db/database.service";
import { currentFacility } from "../platform/facility";
import { code, parse } from "../platform/validation";

const MapBox = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  angle: z.number().default(0),
});

const BerthBody = z.object({
  code,
  name: z.string().min(1),
  berthKind: z
    .enum(["QUAY", "RORO_RAMP", "LIQUID_JETTY", "BARGE"])
    .default("QUAY"),
  startMarkM: z.number().min(0).default(0),
  lengthM: z.number().positive(),
  depthM: z.number().positive().optional(),
  bollardFrom: z.string().max(10).optional(),
  bollardTo: z.string().max(10).optional(),
  map: MapBox.optional(),
});
const RailTrackBody = z.object({
  code,
  lengthM: z.number().positive(),
  maxWagons: z.number().int().positive().optional(),
  map: MapBox.optional(),
});
const GateLaneBody = z.object({
  code,
  direction: z.enum(["IN", "OUT", "BOTH"]),
  laneKind: z.enum(["STANDARD", "TROUBLE", "OOG"]).default("STANDARD"),
  hasOcr: z.boolean().default(false),
  map: MapBox.optional(),
});
const LinkBody = z.object({
  toFacility: code,
  mode: z.enum(["RAIL", "TRUCK", "BARGE"]),
  transitHours: z.number().positive(),
  bonded: z.boolean().default(true),
});

const BERTH_COLS = `b.id, b.code, b.name, b.berth_kind AS "berthKind", b.start_mark_m::float AS "startMarkM", b.length_m::float AS "lengthM",
  b.depth_m::float AS "depthM", b.bollard_from AS "bollardFrom", b.bollard_to AS "bollardTo"`;
const MAP = (a: string) =>
  `CASE WHEN ${a}.map_x IS NULL THEN NULL ELSE json_build_object('x', ${a}.map_x, 'y', ${a}.map_y, 'w', ${a}.map_w, 'h', ${a}.map_h, 'angle', ${a}.map_angle) END AS map`;

/**
 * Terminal model v2: the physical layout of a facility (berths, yard blocks, rail tracks, gate lanes)
 * and its corridors to other facilities. GET /v1/terminal returns the whole picture for the terminal map.
 */
@Controller("v1/terminal")
@FacilityScoped()
export class TerminalController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  map(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const kinds = await tx.one<{ kinds: string[] }>(
        "SELECT kinds FROM facilities WHERE id = $1",
        [f.id],
      );
      // Sequential on purpose: one transaction = one connection.
      const berths = await this.berths(tx, f.id);
      const blocks = await tx.many(
        `SELECT b.id, b.code, y.code AS yard, b.block_type AS "blockType", b.bays, b.rows_count AS rows, b.tiers,
                  b.capacity::float AS capacity, b.capacity_unit AS "capacityUnit", b.equipment_kind AS "equipmentKind",
                  b.allowed_sizes AS "allowedSizes", b.max_stack_kg AS "maxStackKg", b.reefer_plugs AS "reeferPlugs", b.dg_classes AS "dgClasses",
                  ${MAP("b")},
                  (SELECT count(*)::int FROM units u WHERE u.yard_block_id = b.id AND u.state = 'IN_YARD') AS occupied
             FROM yard_blocks b JOIN yards y ON y.id = b.yard_id WHERE y.facility_id = $1 ORDER BY y.code, b.code`,
        [f.id],
      );
      const railTracks = await tx.many(
        `SELECT t.id, t.code, t.length_m::float AS "lengthM", t.max_wagons AS "maxWagons", ${MAP("t")}
             FROM rail_tracks t WHERE t.facility_id = $1 ORDER BY t.code`,
        [f.id],
      );
      const gateLanes = await tx.many(
        `SELECT l.id, l.code, l.direction, l.lane_kind AS "laneKind", l.has_ocr AS "hasOcr", l.status, ${MAP("l")}
             FROM gate_lanes l WHERE l.facility_id = $1 ORDER BY l.code`,
        [f.id],
      );
      const links = await this.links(tx, f.id);
      return {
        facility: f.code,
        kinds: kinds?.kinds ?? [],
        berths,
        blocks,
        railTracks,
        gateLanes,
        links,
      };
    });
  }

  @Post("berths")
  @Roles(ROLES.admin)
  createBerth(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(BerthBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const row = await tx.one<{ id: string }>(
        `INSERT INTO berths (tenant_id, facility_id, code, name, berth_kind, start_mark_m, length_m, depth_m, bollard_from, bollard_to,
                             map_x, map_y, map_w, map_h, map_angle)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          f.id,
          b.code,
          b.name,
          b.berthKind,
          b.startMarkM,
          b.lengthM,
          b.depthM ?? null,
          b.bollardFrom ?? null,
          b.bollardTo ?? null,
          b.map?.x ?? null,
          b.map?.y ?? null,
          b.map?.w ?? null,
          b.map?.h ?? null,
          b.map?.angle ?? 0,
        ],
      );
      return (await this.berths(tx, f.id)).find((x) => x.id === row!.id);
    });
  }

  @Get("berths")
  listBerths(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) =>
      this.berths(tx, (await currentFacility(tx, ctx)).id),
    );
  }

  @Post("rail-tracks")
  @Roles(ROLES.admin)
  createTrack(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(RailTrackBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.one(
        `INSERT INTO rail_tracks (tenant_id, facility_id, code, length_m, max_wagons, map_x, map_y, map_w, map_h, map_angle)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, code, length_m::float AS "lengthM", max_wagons AS "maxWagons"`,
        [
          f.id,
          b.code,
          b.lengthM,
          b.maxWagons ?? null,
          b.map?.x ?? null,
          b.map?.y ?? null,
          b.map?.w ?? null,
          b.map?.h ?? null,
          b.map?.angle ?? 0,
        ],
      );
    });
  }

  @Post("gate-lanes")
  @Roles(ROLES.admin)
  createLane(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(GateLaneBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.one(
        `INSERT INTO gate_lanes (tenant_id, facility_id, code, direction, lane_kind, has_ocr, map_x, map_y, map_w, map_h, map_angle)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, code, direction, lane_kind AS "laneKind", has_ocr AS "hasOcr", status`,
        [
          f.id,
          b.code,
          b.direction,
          b.laneKind,
          b.hasOcr,
          b.map?.x ?? null,
          b.map?.y ?? null,
          b.map?.w ?? null,
          b.map?.h ?? null,
          b.map?.angle ?? 0,
        ],
      );
    });
  }

  /** Corridor from the selected facility to another one (seaport -> dry port shuttle, depot transfer). */
  @Post("links")
  @Roles(ROLES.admin)
  createLink(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(LinkBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const to = await tx.must<{ id: string }>(
        "SELECT id FROM facilities WHERE code = $1",
        [b.toFacility],
        `Facility ${b.toFacility}`,
      );
      await tx.exec(
        `INSERT INTO facility_links (tenant_id, from_facility_id, to_facility_id, mode, transit_hours, bonded)
         VALUES (current_tenant(), $1,$2,$3,$4,$5)`,
        [f.id, to.id, b.mode, b.transitHours, b.bonded],
      );
      return (await this.links(tx, f.id)).find(
        (l) => l.toFacility === b.toFacility && l.mode === b.mode,
      );
    });
  }

  private berths(tx: Tx, facilityId: string) {
    return tx.many(
      `SELECT ${BERTH_COLS}, ${MAP("b")} FROM berths b WHERE b.facility_id = $1 ORDER BY b.start_mark_m, b.code`,
      [facilityId],
    );
  }

  private links(tx: Tx, facilityId: string) {
    return tx.many(
      `SELECT l.id, ff.code AS "fromFacility", tf.code AS "toFacility", tf.kinds AS "toKinds", l.mode, l.transit_hours::float AS "transitHours", l.bonded
         FROM facility_links l JOIN facilities ff ON ff.id = l.from_facility_id JOIN facilities tf ON tf.id = l.to_facility_id
        WHERE l.from_facility_id = $1 OR l.to_facility_id = $1 ORDER BY ff.code, tf.code`,
      [facilityId],
    );
  }
}
