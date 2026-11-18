-- Billing: tariffs (facility- or tenant-wide, optionally per customer contract),
-- charges accrued from domain events, and invoices built from uninvoiced charges.

CREATE TABLE tariffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  facility_id    uuid REFERENCES facilities(id),   -- NULL: applies to every facility of the tenant
  customer_id    uuid REFERENCES partners(id),     -- NULL: standard tariff; set: contract rate
  charge_code    text NOT NULL,
  description    text NOT NULL,
  cargo_kind     text NOT NULL CHECK (cargo_kind IN ('CONTAINER','BREAKBULK','VEHICLE','LIQUID')),
  trigger_event  text NOT NULL CHECK (trigger_event IN ('unit.discharged','unit.loaded','unit.gated-in','unit.gated-out','storage')),
  basis          text NOT NULL CHECK (basis IN ('PER_UNIT','PER_TEU','PER_TONNE','PER_M3','PER_DAY')),
  rate           numeric(14,4) NOT NULL CHECK (rate >= 0),
  currency       char(3) NOT NULL,
  free_days      int NOT NULL DEFAULT 0 CHECK (free_days >= 0),
  valid_from     date NOT NULL DEFAULT current_date,
  valid_to       date,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  facility_id        uuid NOT NULL REFERENCES facilities(id),
  invoice_no         text NOT NULL,
  customer_id        uuid NOT NULL REFERENCES partners(id),
  currency           char(3) NOT NULL,
  total              numeric(14,2) NOT NULL,
  status             text NOT NULL DEFAULT 'FINAL' CHECK (status IN ('DRAFT','FINAL','CANCELLED')),
  erp_export_status  text NOT NULL DEFAULT 'PENDING' CHECK (erp_export_status IN ('PENDING','EXPORTED','FAILED')),
  issued_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_no)
);

CREATE TABLE charges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  unit_id      uuid NOT NULL REFERENCES units(id),
  customer_id  uuid NOT NULL REFERENCES partners(id),
  tariff_id    uuid NOT NULL REFERENCES tariffs(id),
  charge_code  text NOT NULL,
  description  text NOT NULL,
  quantity     numeric(14,4) NOT NULL,
  rate         numeric(14,4) NOT NULL,
  amount       numeric(14,2) NOT NULL,
  currency     char(3) NOT NULL,
  event_type   text NOT NULL,
  event_at     timestamptz NOT NULL,
  invoice_id   uuid REFERENCES invoices(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charges_uninvoiced ON charges (customer_id) WHERE invoice_id IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tariffs','invoices','charges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;
