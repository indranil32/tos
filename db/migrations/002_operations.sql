-- Operations: vessels, visits, cargo units (all cargo kinds), holds, work instructions, gate, EDI log.

CREATE TABLE vessels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  imo          text NOT NULL CHECK (imo ~ '^[0-9]{7}$'),
  name         text NOT NULL,
  call_sign    text,
  vessel_type  text NOT NULL DEFAULT 'CONTAINER'
               CHECK (vessel_type IN ('CONTAINER','GENERAL_CARGO','RORO','TANKER','BULK','CRUISE','OTHER')),
  loa_m        numeric,
  UNIQUE (tenant_id, imo)
);

CREATE TABLE vessel_visits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  facility_id       uuid NOT NULL REFERENCES facilities(id),
  vessel_id         uuid NOT NULL REFERENCES vessels(id),
  visit_ref         text NOT NULL,
  line_operator_id  uuid REFERENCES partners(id),
  voyage_in         text,
  voyage_out        text,
  berth             text,
  eta               timestamptz,
  etd               timestamptz,
  ata               timestamptz,
  atd               timestamptz,
  phase             text NOT NULL DEFAULT 'PLANNED'
                    CHECK (phase IN ('PLANNED','ARRIVED','WORKING','COMPLETED','DEPARTED','CANCELLED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, visit_ref)
);

-- A unit is any tracked cargo item: a container, a break-bulk lot, a vehicle or a liquid parcel.
CREATE TABLE units (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  facility_id       uuid NOT NULL REFERENCES facilities(id),
  cargo_kind        text NOT NULL CHECK (cargo_kind IN ('CONTAINER','BREAKBULK','VEHICLE','LIQUID')),
  unit_ref          text NOT NULL,      -- ISO 6346 container no, ISO 3779 VIN, lot ref or parcel ref
  iso_type          text,               -- ISO 6346 size/type, containers only
  freight_kind      text NOT NULL DEFAULT 'FCL' CHECK (freight_kind IN ('FCL','LCL','MTY','NA')),
  category          text NOT NULL CHECK (category IN ('IMPORT','EXPORT','TRANSSHIP','STORAGE')),
  gross_weight_kg   numeric CHECK (gross_weight_kg IS NULL OR gross_weight_kg >= 0),
  vgm_kg            numeric,
  quantity          numeric NOT NULL DEFAULT 1,
  quantity_uom      text NOT NULL DEFAULT 'UNIT',  -- UNIT, PCS, MT, M3
  line_operator_id  uuid REFERENCES partners(id),
  visit_in_id       uuid REFERENCES vessel_visits(id),
  visit_out_id      uuid REFERENCES vessel_visits(id),
  pol               text,               -- UN/LOCODE
  pod               text,
  dg_un_number      text,
  dg_class          text,               -- IMDG class
  is_reefer         boolean NOT NULL DEFAULT false,
  seal_numbers      text[] NOT NULL DEFAULT '{}',
  state             text NOT NULL DEFAULT 'ADVISED'
                    CHECK (state IN ('ADVISED','IN_YARD','LOADED','DEPARTED')),
  yard_block_id     uuid REFERENCES yard_blocks(id),
  yard_position     text,
  time_in           timestamptz,
  time_out          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- A reference can only be active once per facility; history is kept after departure.
CREATE UNIQUE INDEX units_active_ref ON units (facility_id, unit_ref) WHERE state <> 'DEPARTED';
CREATE UNIQUE INDEX units_yard_slot ON units (yard_block_id, yard_position) WHERE state = 'IN_YARD' AND yard_position IS NOT NULL;

CREATE TABLE unit_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  unit_id      uuid NOT NULL REFERENCES units(id),
  hold_type    text NOT NULL CHECK (hold_type IN ('CUSTOMS','LINE','TERMINAL','DG','INSPECTION')),
  reference    text,
  applied_by   text,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  released_by  text,
  released_at  timestamptz
);
CREATE INDEX unit_holds_active ON unit_holds (unit_id) WHERE released_at IS NULL;

CREATE TABLE work_instructions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  unit_id        uuid NOT NULL REFERENCES units(id),
  visit_id       uuid REFERENCES vessel_visits(id),
  move_kind      text NOT NULL CHECK (move_kind IN ('DISCHARGE','LOAD','YARD_SHIFT','GATE_IN','GATE_OUT')),
  from_position  text,
  to_position    text,
  che_id         text,
  status         text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','COMPLETED','CANCELLED')),
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gate_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  direction      text NOT NULL CHECK (direction IN ('IN','OUT')),
  unit_id        uuid REFERENCES units(id),
  unit_ref       text NOT NULL,
  truck_plate    text,
  haulier_id     uuid REFERENCES partners(id),
  status         text NOT NULL CHECK (status IN ('COMPLETED','REJECTED')),
  reject_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE edi_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  facility_id      uuid REFERENCES facilities(id),
  direction        text NOT NULL CHECK (direction IN ('IN','OUT')),
  message_type     text NOT NULL,
  interchange_ref  text,
  partner_code     text,
  raw              text NOT NULL,
  status           text NOT NULL CHECK (status IN ('ACCEPTED','REJECTED','GENERATED')),
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vessels','vessel_visits','units','unit_holds','work_instructions','gate_transactions','edi_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;
