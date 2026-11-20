-- Phase 1: vessel planning. Vessel profiles, berth plan, arrival stowage (BAPLIE in) and crane split.

-- 1. Vessel profile ----------------------------------------------------------------------------
-- Enough structure to draw a bay plan and validate cells. Detailed hatch and stability data come later.
ALTER TABLE vessels
  ADD COLUMN beam_m        numeric CHECK (beam_m IS NULL OR beam_m > 0),
  ADD COLUMN max_draft_m   numeric CHECK (max_draft_m IS NULL OR max_draft_m > 0),
  ADD COLUMN max_bay       integer CHECK (max_bay IS NULL OR max_bay BETWEEN 1 AND 199),  -- highest bay number (odd 20' bays)
  ADD COLUMN max_row       integer CHECK (max_row IS NULL OR max_row BETWEEN 0 AND 30),   -- highest row number (00 = centre)
  ADD COLUMN hold_tiers    integer CHECK (hold_tiers IS NULL OR hold_tiers BETWEEN 1 AND 15), -- tiers 02, 04 ... in the hold
  ADD COLUMN deck_tiers    integer CHECK (deck_tiers IS NULL OR deck_tiers BETWEEN 1 AND 12); -- tiers 82, 84 ... on deck

-- 2. Berth plan ---------------------------------------------------------------------------------
ALTER TABLE vessel_visits
  ADD COLUMN berth_id       uuid REFERENCES berths(id),
  ADD COLUMN quay_from_m    numeric CHECK (quay_from_m IS NULL OR quay_from_m >= 0), -- quay mark of the vessel's first metre
  ADD COLUMN etb            timestamptz,   -- estimated time of berthing
  ADD COLUMN side_to        text CHECK (side_to IS NULL OR side_to IN ('PORT','STARBOARD')),
  ADD COLUMN moves_per_hour numeric CHECK (moves_per_hour IS NULL OR moves_per_hour > 0); -- planned gross crane rate
CREATE INDEX vessel_visits_berth_window ON vessel_visits (facility_id, etb, etd) WHERE berth_id IS NOT NULL;

-- 3. Stowage on board ---------------------------------------------------------------------------
-- What is on board, cell by cell: the arrival bay plan (BAPLIE in) plus remain-on-board cargo.
-- Units for this port are also units (discharge list); this table keeps the whole vessel picture.
CREATE TABLE vessel_stow (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  visit_id      uuid NOT NULL REFERENCES vessel_visits(id),
  cell          text NOT NULL CHECK (cell ~ '^[0-9]{7}$'),   -- bay(3) row(2) tier(2), normalised to 7 digits
  unit_ref      text,
  iso_type      text,
  freight_kind  text NOT NULL DEFAULT 'FCL',
  weight_kg     numeric,
  pol           text,
  pod           text,
  line_code     text,
  dg_class      text,
  dg_un_number  text,
  is_reefer     boolean NOT NULL DEFAULT false,
  disposition   text NOT NULL CHECK (disposition IN ('ROB','DISCHARGE','RESTOW')),
  source        text NOT NULL DEFAULT 'BAPLIE' CHECK (source IN ('BAPLIE','API')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visit_id, cell)
);
CREATE INDEX vessel_stow_unit ON vessel_stow (visit_id, unit_ref);

-- 4. Crane split -------------------------------------------------------------------------------
ALTER TABLE work_queues
  ADD COLUMN bay_from integer,
  ADD COLUMN bay_to   integer;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE vessel_stow ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE vessel_stow FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON vessel_stow USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())';
END $$;
