-- Phase 0 foundations: terminal model v2, equipment, shifts and gangs, work queues.
-- Every new table is tenant-owned and protected by row-level security (loop at the end).

-- 1. Facility kinds and corridors -------------------------------------------------------------

-- A facility can combine kinds: a dry port often runs an empty depot and a CFS on the same site.
ALTER TABLE facilities
  ADD COLUMN kinds text[] NOT NULL DEFAULT '{SEAPORT}'
    CHECK (kinds <@ ARRAY['SEAPORT','DRY_PORT','DEPOT','CFS']::text[] AND cardinality(kinds) > 0);

-- Corridor between two facilities (seaport <-> dry port shuttles, depot transfers).
CREATE TABLE facility_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  from_facility_id  uuid NOT NULL REFERENCES facilities(id),
  to_facility_id    uuid NOT NULL REFERENCES facilities(id),
  mode              text NOT NULL CHECK (mode IN ('RAIL','TRUCK','BARGE')),
  transit_hours     numeric NOT NULL CHECK (transit_hours > 0),
  bonded            boolean NOT NULL DEFAULT true,
  CHECK (from_facility_id <> to_facility_id),
  UNIQUE (from_facility_id, to_facility_id, mode)
);

-- 2. Yard blocks v2: stacking rules and map geometry ------------------------------------------

ALTER TABLE yard_blocks DROP CONSTRAINT yard_blocks_block_type_check;
ALTER TABLE yard_blocks ADD CONSTRAINT yard_blocks_block_type_check
  CHECK (block_type IN ('CONTAINER_STACK','LAYDOWN','RORO_LANE','TANK','WAREHOUSE'));
ALTER TABLE yard_blocks
  ADD COLUMN equipment_kind  text,                       -- machine type serving the block (RTG, RMG, RS, SC, FLT ...)
  ADD COLUMN allowed_sizes   text[] NOT NULL DEFAULT '{20,40,45}' CHECK (allowed_sizes <@ ARRAY['20','40','45']::text[]),
  ADD COLUMN max_stack_kg    integer CHECK (max_stack_kg IS NULL OR max_stack_kg > 0),
  ADD COLUMN reefer_plugs    integer NOT NULL DEFAULT 0 CHECK (reefer_plugs >= 0),
  ADD COLUMN dg_classes      text[] NOT NULL DEFAULT '{}', -- IMDG classes allowed in the block; empty = none
  ADD COLUMN capacity_unit   text CHECK (capacity_unit IS NULL OR capacity_unit IN ('SLOTS','M2','LANE_M','VEHICLES','M3','PALLETS')),
  ADD COLUMN map_x numeric, ADD COLUMN map_y numeric, ADD COLUMN map_w numeric, ADD COLUMN map_h numeric,
  ADD COLUMN map_angle numeric NOT NULL DEFAULT 0;

-- 3. Quay, rail and gate infrastructure -------------------------------------------------------

CREATE TABLE berths (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  code           text NOT NULL,
  name           text NOT NULL,
  berth_kind     text NOT NULL DEFAULT 'QUAY' CHECK (berth_kind IN ('QUAY','RORO_RAMP','LIQUID_JETTY','BARGE')),
  start_mark_m   numeric NOT NULL DEFAULT 0 CHECK (start_mark_m >= 0), -- quay metre mark where the berth starts
  length_m       numeric NOT NULL CHECK (length_m > 0),
  depth_m        numeric CHECK (depth_m IS NULL OR depth_m > 0),
  bollard_from   text,
  bollard_to     text,
  map_x numeric, map_y numeric, map_w numeric, map_h numeric, map_angle numeric NOT NULL DEFAULT 0,
  UNIQUE (facility_id, code)
);

CREATE TABLE rail_tracks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  code         text NOT NULL,
  length_m     numeric NOT NULL CHECK (length_m > 0),
  max_wagons   integer CHECK (max_wagons IS NULL OR max_wagons > 0),
  map_x numeric, map_y numeric, map_w numeric, map_h numeric, map_angle numeric NOT NULL DEFAULT 0,
  UNIQUE (facility_id, code)
);

CREATE TABLE gate_lanes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  code         text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('IN','OUT','BOTH')),
  lane_kind    text NOT NULL DEFAULT 'STANDARD' CHECK (lane_kind IN ('STANDARD','TROUBLE','OOG')),
  has_ocr      boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  map_x numeric, map_y numeric, map_w numeric, map_h numeric, map_angle numeric NOT NULL DEFAULT 0,
  UNIQUE (facility_id, code)
);

-- 4. Equipment (CHE), pools, shifts and gangs --------------------------------------------------

CREATE TABLE equipment_pools (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  code         text NOT NULL,
  name         text NOT NULL,
  UNIQUE (facility_id, code)
);

CREATE TABLE equipment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  code           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('QC','MHC','RTG','RMG','RS','ECH','SC','TT','FLT','MAFI','RAIL_CRANE','PUMP')),
  pool_id        uuid REFERENCES equipment_pools(id),
  status         text NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('OFFLINE','IDLE','WORKING','BREAKDOWN','MAINTENANCE')),
  status_since   timestamptz NOT NULL DEFAULT now(),
  status_reason  text,
  max_weight_kg  integer CHECK (max_weight_kg IS NULL OR max_weight_kg > 0),
  twin_lift      boolean NOT NULL DEFAULT false,
  position       text,       -- last known position (yard slot, berth, lane)
  operator       text,       -- logged-on operator
  UNIQUE (facility_id, code)
);

CREATE TABLE equipment_status_log (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  equipment_id  uuid NOT NULL REFERENCES equipment(id),
  status        text NOT NULL,
  reason        text,
  operator      text,
  actor         text,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_status_log_eq ON equipment_status_log (equipment_id, at DESC);

CREATE TABLE shifts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  code         text NOT NULL,
  name         text NOT NULL,
  starts_at    time NOT NULL,
  ends_at      time NOT NULL,   -- may be earlier than starts_at for a night shift
  UNIQUE (facility_id, code)
);

CREATE TABLE gangs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  code         text NOT NULL,
  name         text NOT NULL,
  shift_id     uuid REFERENCES shifts(id),
  members      text[] NOT NULL DEFAULT '{}',
  UNIQUE (facility_id, code)
);

-- 5. Work queues and the work-instruction life cycle -------------------------------------------

-- A work queue is an ordered list of moves for one point of work (a crane on a vessel, a rail track,
-- a yard block for housekeeping). The dispatcher hands the head of each queue to a machine.
CREATE TABLE work_queues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  code          text NOT NULL,
  name          text NOT NULL,
  pow_kind      text NOT NULL CHECK (pow_kind IN ('VESSEL','YARD','RAIL','GATE','HOUSEKEEPING','CFS','DEPOT')),
  visit_id      uuid REFERENCES vessel_visits(id),
  equipment_id  uuid REFERENCES equipment(id),    -- the POW machine, if the queue is dedicated
  pool_id       uuid REFERENCES equipment_pools(id), -- or a pool of machines that may take its jobs
  priority      integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 1 AND 100), -- 1 = most urgent
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);

ALTER TABLE work_instructions DROP CONSTRAINT work_instructions_status_check;
ALTER TABLE work_instructions ADD CONSTRAINT work_instructions_status_check
  CHECK (status IN ('PLANNED','DISPATCHED','IN_PROGRESS','COMPLETED','CANCELLED'));
ALTER TABLE work_instructions DROP CONSTRAINT work_instructions_move_kind_check;
ALTER TABLE work_instructions ADD CONSTRAINT work_instructions_move_kind_check
  CHECK (move_kind IN ('DISCHARGE','LOAD','YARD_SHIFT','GATE_IN','GATE_OUT','HOUSEKEEPING','RAIL_DISCHARGE','RAIL_LOAD'));
ALTER TABLE work_instructions
  ADD COLUMN work_queue_id  uuid REFERENCES work_queues(id),
  ADD COLUMN sequence       integer,
  ADD COLUMN equipment_id   uuid REFERENCES equipment(id),
  ADD COLUMN planned_position text,              -- target slot chosen by the planner, if any
  ADD COLUMN dispatched_at  timestamptz,
  ADD COLUMN started_at     timestamptz,
  ADD COLUMN version        integer NOT NULL DEFAULT 0; -- optimistic locking for planners and devices
CREATE INDEX work_instructions_queue ON work_instructions (work_queue_id, status, sequence);
CREATE INDEX work_instructions_equipment ON work_instructions (equipment_id) WHERE status IN ('DISPATCHED','IN_PROGRESS');

-- 6. Real-time: wake listeners when an event is committed ---------------------------------------

-- NOTIFY is delivered only on commit, so listeners never see rolled-back events.
CREATE OR REPLACE FUNCTION notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('tos_events', NEW.tenant_id::text || ':' || NEW.id::text);
  RETURN NULL;
END $$;
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION notify_outbox();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['facility_links','berths','rail_tracks','gate_lanes','equipment_pools','equipment',
                           'equipment_status_log','shifts','gangs','work_queues'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;
