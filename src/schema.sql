-- ============================================================================
-- CBMP — Wave 0 (core) + Wave 1 (Sales) schema
-- Mirrors core.js STAGES / ROLES exactly. Field names chosen to map 1:1
-- back onto the original prototype's object shapes wherever practical.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN (
    'System Admin', 'B2B Sales', 'Sales Manager', 'Cloud Engineer', 'Cloud Manager',
    'Finance User', 'Finance Manager', 'Legal User', 'Management', 'Customer User', 'Auditor'
  )),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT,
  segment TEXT,
  account_manager TEXT,
  health_score INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_catalogue (
  id TEXT PRIMARY KEY, -- SKU, e.g. 'SKU-CMP-001'
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT,
  nrc NUMERIC(14,2) NOT NULL DEFAULT 0,
  mrc NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax NUMERIC(5,2) NOT NULL DEFAULT 17,
  gl_code TEXT,
  revenue_category TEXT,
  cost NUMERIC(14,2),
  margin NUMERIC(5,2),
  sla TEXT,
  provisioning_owner TEXT,
  capacity_requirement TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gl_mappings (
  id SERIAL PRIMARY KEY,
  revenue_category TEXT NOT NULL,
  gl_code TEXT NOT NULL,
  gl_description TEXT
);

-- Full 16-stage lifecycle lives in businessRules.js; this column just stores
-- whichever stage id a lead is currently in. Wave 1 only writes/reads the
-- Sales-cluster stages (lead_created ... customer_accepted/rejected) — the
-- rest become reachable once Delivery/Finance (Wave 2+) are built.
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, -- 'L-1001' style, matches original ID scheme
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_name TEXT,
  source TEXT,
  est_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'lead_created',
  owner_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, -- 'PRO-5001' style
  lead_id TEXT NOT NULL REFERENCES leads(id),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'Sent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposal_line_items (
  id SERIAL PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES service_catalogue(id),
  qty NUMERIC(10,2) NOT NULL DEFAULT 1,
  rate NUMERIC(14,2) NOT NULL DEFAULT 0,
  nrc NUMERIC(14,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS negotiations (
  id TEXT PRIMARY KEY, -- 'NEG-01' style
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  round INTEGER NOT NULL,
  requested_changes TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id), -- NULL = broadcast to all
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
