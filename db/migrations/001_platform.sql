-- Platform: tenancy hierarchy, partners, outbox.
-- Hierarchy: tenant -> complex -> facility (terminal) -> yard -> yard_block -> slot (position string).
-- Every tenant-owned table carries tenant_id and is protected by row-level security (RLS).
-- The application connects as role tos_app and sets app.tenant_id per transaction.

-- gen_random_uuid() is built in since PostgreSQL 13: no extension needed (works on managed services).

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Tenants are platform-level records (no RLS): provisioning is a platform-admin action.
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name          text NOT NULL,
  oidc_issuer   text UNIQUE,              -- one IdP realm per tenant (Keycloak realm, Entra tenant, ...)
  data_region   text NOT NULL DEFAULT 'default',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE complexes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,
  name       text NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE facilities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  complex_id     uuid NOT NULL REFERENCES complexes(id),
  code           text NOT NULL,
  name           text NOT NULL,
  facility_type  text NOT NULL DEFAULT 'MULTIPURPOSE'
                 CHECK (facility_type IN ('MULTIPURPOSE','CONTAINER','BREAKBULK','RORO','LIQUID_BULK')),
  unlocode       text CHECK (unlocode IS NULL OR unlocode ~ '^[A-Z]{2}[A-Z2-9]{3}$'),
  smdg_code      text,
  timezone       text NOT NULL DEFAULT 'UTC',
  currency       char(3) NOT NULL DEFAULT 'USD',
  UNIQUE (tenant_id, code)
);

CREATE TABLE yards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  code         text NOT NULL,
  name         text NOT NULL,
  UNIQUE (facility_id, code)
);

CREATE TABLE yard_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  yard_id     uuid NOT NULL REFERENCES yards(id),
  code        text NOT NULL,
  block_type  text NOT NULL CHECK (block_type IN ('CONTAINER_STACK','LAYDOWN','RORO_LANE','TANK')),
  bays        int  NOT NULL DEFAULT 1 CHECK (bays > 0),
  rows_count  int  NOT NULL DEFAULT 1 CHECK (rows_count > 0),
  tiers       int  NOT NULL DEFAULT 1 CHECK (tiers > 0),
  capacity    numeric,                 -- m2 for laydown, vehicles for RoRo lanes, m3 for tanks
  UNIQUE (yard_id, code)
);

CREATE TABLE partners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,             -- e.g. SMDG line code or customer code
  name       text NOT NULL,
  roles      text[] NOT NULL DEFAULT '{}', -- LINE_OPERATOR, AGENT, HAULIER, CONSIGNEE, CUSTOMER
  is_aeo     boolean NOT NULL DEFAULT false, -- WCO SAFE Authorised Economic Operator
  erp_customer_ref text,
  UNIQUE (tenant_id, code)
);

-- Transactional outbox: every domain event is written in the same transaction as the change.
-- A dispatcher publishes them to webhooks, EDI generators and (optionally) Kafka.
CREATE TABLE outbox_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  facility_id     uuid REFERENCES facilities(id),
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  payload         jsonb NOT NULL,
  actor           text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX outbox_unpublished ON outbox_events (occurred_at) WHERE published_at IS NULL;

CREATE TABLE counters (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  value      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['complexes','facilities','yards','yard_blocks','partners','outbox_events','counters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;
