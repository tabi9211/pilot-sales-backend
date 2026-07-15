require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

// Matches core.js defaultData().users exactly (id/name/role/email), with a
// derived username (first name, lowercased) for login. Password is the same
// for every seed user unless overridden per-user via env — fine for a pilot,
// change before this touches anything real.
const USERS = [
  { username: 'ayesha',  name: 'Ayesha Khan',     role: 'System Admin',    email: 'ayesha.khan@telco.com' },
  { username: 'bilal',   name: 'Bilal Ahmed',     role: 'B2B Sales',       email: 'bilal.ahmed@telco.com' },
  { username: 'sana',    name: 'Sana Malik',      role: 'Sales Manager',   email: 'sana.malik@telco.com' },
  { username: 'usman',   name: 'Usman Tariq',     role: 'Cloud Engineer',  email: 'usman.tariq@telco.com' },
  { username: 'fatima',  name: 'Fatima Raza',     role: 'Cloud Manager',   email: 'fatima.raza@telco.com' },
  { username: 'hamza',   name: 'Hamza Sheikh',    role: 'Finance User',    email: 'hamza.sheikh@telco.com' },
  { username: 'zara',    name: 'Zara Iqbal',      role: 'Finance Manager', email: 'zara.iqbal@telco.com' },
  { username: 'omar',    name: 'Omar Farooq',     role: 'Legal User',      email: 'omar.farooq@telco.com' },
  { username: 'nadia',   name: 'Nadia Chaudhry',  role: 'Management',      email: 'nadia.chaudhry@telco.com' },
  { username: 'customer',name: 'Demo Customer',   role: 'Customer User',   email: 'customer@clientco.com' },
  { username: 'imran',   name: 'Imran Qureshi',   role: 'Auditor',         email: 'imran.qureshi@telco.com' },
];

const CUSTOMERS = [
  { name: 'Askari Textiles Ltd', industry: 'Manufacturing', segment: 'Enterprise', accountManager: 'Bilal Ahmed', healthScore: 82 },
  { name: 'Meridian Bank', industry: 'BFSI', segment: 'Strategic', accountManager: 'Sana Malik', healthScore: 91 },
  { name: 'Horizon Retail Group', industry: 'Retail', segment: 'Enterprise', accountManager: 'Bilal Ahmed', healthScore: 64 },
  { name: 'Falcon Logistics', industry: 'Logistics', segment: 'Mid-Market', accountManager: 'Bilal Ahmed', healthScore: 73 },
  { name: 'Crescent Healthcare', industry: 'Healthcare', segment: 'Enterprise', accountManager: 'Sana Malik', healthScore: 55 },
];

const CONTACTS_BY_CUSTOMER_INDEX = [
  { name: 'Kamran Aziz', title: 'Head of IT', email: 'kamran.aziz@askari.com', phone: '0300-1112233' },
  { name: 'Ali Raza', title: 'CTO', email: 'ali.raza@meridianbank.com', phone: '0301-2223344' },
  { name: 'Sarah Yousaf', title: 'Procurement Manager', email: 'sarah.yousaf@horizonretail.com', phone: '0302-3334455' },
  { name: 'Danish Malik', title: 'Operations Director', email: 'danish.malik@falconlog.com', phone: '0303-4445566' },
  { name: 'Dr. Ayaan Siddiqui', title: 'IT Administrator', email: 'ayaan.siddiqui@crescenthc.com', phone: '0304-5556677' },
];

const SERVICE_CATALOGUE = [
  { id: 'SKU-CMP-001', name: 'Virtual Machine — Standard (4 vCPU/16GB)', category: 'Compute', unit: 'per VM/month', nrc: 15000, mrc: 45000, tax: 17, glCode: 'GL-4001', revenueCategory: 'Compute Revenue', cost: 24000, margin: 46.7, sla: '99.9% uptime', provisioningOwner: 'Cloud Engineer', capacityRequirement: '4 vCPU / 16GB RAM' },
  { id: 'SKU-STG-001', name: 'Block Storage — SSD Tier', category: 'Storage', unit: 'per TB/month', nrc: 5000, mrc: 12000, tax: 17, glCode: 'GL-4002', revenueCategory: 'Storage Revenue', cost: 6500, margin: 45.8, sla: '99.9% availability', provisioningOwner: 'Cloud Engineer', capacityRequirement: '1 TB SSD' },
  { id: 'SKU-BKP-001', name: 'Managed Backup Service', category: 'Backup', unit: 'per TB/month', nrc: 3000, mrc: 8000, tax: 17, glCode: 'GL-4003', revenueCategory: 'Backup Revenue', cost: 4200, margin: 47.5, sla: '99.5% job success rate', provisioningOwner: 'Cloud Engineer', capacityRequirement: '1 TB backup capacity' },
  { id: 'SKU-FW-001', name: 'Managed Firewall — Enterprise', category: 'Firewall', unit: 'per instance/month', nrc: 25000, mrc: 60000, tax: 17, glCode: 'GL-4004', revenueCategory: 'Security Revenue', cost: 32000, margin: 46.7, sla: '99.95% uptime', provisioningOwner: 'Cloud Engineer', capacityRequirement: '1 FW instance (2 Gbps)' },
  { id: 'SKU-WAF-001', name: 'Web Application Firewall', category: 'WAF', unit: 'per domain/month', nrc: 15000, mrc: 35000, tax: 17, glCode: 'GL-4005', revenueCategory: 'Security Revenue', cost: 18000, margin: 48.6, sla: '99.9% uptime', provisioningOwner: 'Cloud Engineer', capacityRequirement: 'Shared WAF pool' },
  { id: 'SKU-DR-001', name: 'Disaster Recovery — Warm Standby', category: 'DR', unit: 'per environment/month', nrc: 60000, mrc: 150000, tax: 17, glCode: 'GL-4006', revenueCategory: 'DR Revenue', cost: 85000, margin: 43.3, sla: 'RTO 4 hrs / RPO 1 hr', provisioningOwner: 'Cloud Manager', capacityRequirement: 'Mirrored environment' },
  { id: 'SKU-LB-001', name: 'Load Balancer — Managed', category: 'Load Balancer', unit: 'per instance/month', nrc: 10000, mrc: 28000, tax: 17, glCode: 'GL-4007', revenueCategory: 'Network Revenue', cost: 14500, margin: 48.2, sla: '99.9% uptime', provisioningOwner: 'Cloud Engineer', capacityRequirement: 'Shared LB pool' },
  { id: 'SKU-MS-001', name: 'Managed Services — 24x7 NOC', category: 'Managed Services', unit: 'per environment/month', nrc: 20000, mrc: 95000, tax: 17, glCode: 'GL-4008', revenueCategory: 'Managed Services Revenue', cost: 58000, margin: 38.9, sla: '15 min incident response', provisioningOwner: 'Cloud Manager', capacityRequirement: 'N/A — service' },
  { id: 'SKU-NET-001', name: 'MPLS / SD-WAN Link — 100Mbps', category: 'Network', unit: 'per link/month', nrc: 30000, mrc: 40000, tax: 17, glCode: 'GL-4009', revenueCategory: 'Network Revenue', cost: 22000, margin: 45.0, sla: '99.5% uptime', provisioningOwner: 'Cloud Engineer', capacityRequirement: '100 Mbps circuit' },
  { id: 'SKU-SEC-001', name: 'SIEM / SOC Monitoring', category: 'Security', unit: 'per environment/month', nrc: 25000, mrc: 70000, tax: 17, glCode: 'GL-4010', revenueCategory: 'Security Revenue', cost: 41000, margin: 41.4, sla: '30 min alert triage', provisioningOwner: 'Cloud Manager', capacityRequirement: 'N/A — service' },
];

const GL_MAPPINGS = [
  { revenueCategory: 'Compute Revenue', glCode: 'GL-4001', glDescription: 'Cloud Compute Income' },
  { revenueCategory: 'Storage Revenue', glCode: 'GL-4002', glDescription: 'Cloud Storage Income' },
  { revenueCategory: 'Backup Revenue', glCode: 'GL-4003', glDescription: 'Managed Backup Income' },
  { revenueCategory: 'Security Revenue', glCode: 'GL-4004/05/10', glDescription: 'Security Services Income' },
  { revenueCategory: 'DR Revenue', glCode: 'GL-4006', glDescription: 'Disaster Recovery Income' },
  { revenueCategory: 'Network Revenue', glCode: 'GL-4007/09', glDescription: 'Network Services Income' },
  { revenueCategory: 'Managed Services Revenue', glCode: 'GL-4008', glDescription: 'Managed Services Income' },
];

async function seedUsers() {
  const defaultPassword = process.env.SEED_DEFAULT_PASSWORD || 'ChangeMe@123';
  for (const u of USERS) {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [u.username]);
    if (rows.length) {
      console.log(`User "${u.username}" already exists — skipping.`);
      continue;
    }
    const hash = await bcrypt.hash(defaultPassword, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, name, email, role) VALUES ($1,$2,$3,$4,$5)',
      [u.username, hash, u.name, u.email, u.role]
    );
    console.log(`Created ${u.role} user "${u.username}".`);
  }
}

async function seedCustomersAndContacts() {
  const { rows: existing } = await pool.query('SELECT id, name FROM customers');
  if (existing.length) {
    console.log('Customers already seeded — skipping.');
    return;
  }
  for (let i = 0; i < CUSTOMERS.length; i++) {
    const c = CUSTOMERS[i];
    const { rows } = await pool.query(
      'INSERT INTO customers (name, industry, segment, account_manager, health_score) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [c.name, c.industry, c.segment, c.accountManager, c.healthScore]
    );
    const customerId = rows[0].id;
    const contact = CONTACTS_BY_CUSTOMER_INDEX[i];
    await pool.query(
      'INSERT INTO contacts (customer_id, name, title, email, phone) VALUES ($1,$2,$3,$4,$5)',
      [customerId, contact.name, contact.title, contact.email, contact.phone]
    );
  }
  console.log(`Seeded ${CUSTOMERS.length} customers with contacts.`);
}

async function seedCatalogue() {
  const { rows: existing } = await pool.query('SELECT id FROM service_catalogue');
  if (existing.length) {
    console.log('Service catalogue already seeded — skipping.');
    return;
  }
  for (const s of SERVICE_CATALOGUE) {
    await pool.query(
      `INSERT INTO service_catalogue
       (id, name, category, unit, nrc, mrc, tax, gl_code, revenue_category, cost, margin, sla, provisioning_owner, capacity_requirement)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [s.id, s.name, s.category, s.unit, s.nrc, s.mrc, s.tax, s.glCode, s.revenueCategory, s.cost, s.margin, s.sla, s.provisioningOwner, s.capacityRequirement]
    );
  }
  for (const g of GL_MAPPINGS) {
    await pool.query(
      'INSERT INTO gl_mappings (revenue_category, gl_code, gl_description) VALUES ($1,$2,$3)',
      [g.revenueCategory, g.glCode, g.glDescription]
    );
  }
  console.log(`Seeded ${SERVICE_CATALOGUE.length} catalogue items and ${GL_MAPPINGS.length} GL mappings.`);
}

const CAPACITY_POOL = [
  { resource: 'CPU (vCores)', total: 4000, used: 2650 },
  { resource: 'RAM (GB)', total: 16000, used: 10200 },
  { resource: 'Storage (TB)', total: 900, used: 610 },
  { resource: 'Firewall Instances', total: 40, used: 27 },
  { resource: 'Backup Capacity (TB)', total: 500, used: 340 },
];

async function seedCapacityPool() {
  const { rows: existing } = await pool.query('SELECT resource FROM capacity_pool');
  if (existing.length) {
    console.log('Capacity pool already seeded — skipping.');
    return;
  }
  for (const c of CAPACITY_POOL) {
    await pool.query(
      'INSERT INTO capacity_pool (resource, total, used) VALUES ($1,$2,$3)',
      [c.resource, c.total, c.used]
    );
  }
  console.log(`Seeded ${CAPACITY_POOL.length} capacity pool resources.`);
}

async function seed() {
  await seedUsers();
  await seedCustomersAndContacts();
  await seedCatalogue();
  await seedCapacityPool();
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
