const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Customer list is needed across multiple clusters (Sales creates leads
// against them, Delivery/Finance reference them later) — no cluster gate
// here, just requires being logged in. Revisit if a cluster needs stricter
// customer-level scoping in a later wave.
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM customers ORDER BY name');
  res.json({ customers: rows });
});

router.get('/:id/contacts', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contacts WHERE customer_id = $1', [req.params.id]);
  res.json({ contacts: rows });
});

module.exports = router;
