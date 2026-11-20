-- Phase 1: yard allocation strategy. Planner-defined ranges reserve parts of blocks for a group of cargo.
CREATE TABLE yard_ranges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  block_id      uuid NOT NULL REFERENCES yard_blocks(id),
  name          text NOT NULL,
  bay_from      integer NOT NULL CHECK (bay_from >= 1),
  bay_to        integer NOT NULL,
  row_from      integer NOT NULL CHECK (row_from >= 1),
  row_to        integer NOT NULL,
  -- what may go here (null = any)
  purpose       text NOT NULL DEFAULT 'ANY' CHECK (purpose IN ('ANY','EXPORT','IMPORT','EMPTY','TRANSSHIP')),
  visit_id      uuid REFERENCES vessel_visits(id),
  pod           text,
  line_code     text,
  size          text CHECK (size IS NULL OR size IN ('20','40','45')),
  weight_class  text CHECK (weight_class IS NULL OR weight_class IN ('L','M','H')),
  reefer        boolean,
  priority      integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 1 AND 100), -- 1 = tried first
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (bay_to >= bay_from AND row_to >= row_from)
);
CREATE INDEX yard_ranges_facility ON yard_ranges (facility_id) WHERE active;

ALTER TABLE yard_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE yard_ranges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON yard_ranges USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- Restow moves: cargo that stays on board but must come off and go back on to reach this port's units.
-- It is not terminal inventory, so a restow instruction points at its bay-plan cell instead of a unit.
ALTER TABLE work_instructions DROP CONSTRAINT work_instructions_move_kind_check;
ALTER TABLE work_instructions ADD CONSTRAINT work_instructions_move_kind_check
  CHECK (move_kind IN ('DISCHARGE','LOAD','YARD_SHIFT','GATE_IN','GATE_OUT','HOUSEKEEPING','RAIL_DISCHARGE','RAIL_LOAD','RESTOW'));
ALTER TABLE work_instructions
  ALTER COLUMN unit_id DROP NOT NULL,
  ADD COLUMN stow_id uuid REFERENCES vessel_stow(id) ON DELETE CASCADE,
  ADD CONSTRAINT work_instructions_subject CHECK (unit_id IS NOT NULL OR stow_id IS NOT NULL);
