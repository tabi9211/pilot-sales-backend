require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function upsertUser(username, password, role) {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (rows.length) {
    console.log(`User "${username}" already exists — skipping.`);
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
    [username, hash, role]
  );
  console.log(`Created ${role} user "${username}".`);
}

async function seed() {
  await upsertUser(
    process.env.SEED_REP_USERNAME || 'rep1',
    process.env.SEED_REP_PASSWORD || 'Rep@12345',
    'sales_rep'
  );
  await upsertUser(
    process.env.SEED_MANAGER_USERNAME || 'mgr1',
    process.env.SEED_MANAGER_PASSWORD || 'Manager@12345',
    'sales_manager'
  );
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
