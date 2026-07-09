CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('sales_rep', 'sales_manager')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  contact_name TEXT,
  est_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'New' CHECK (stage IN ('New', 'Qualified', 'Proposal', 'Won', 'Lost')),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  approval_status TEXT CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
