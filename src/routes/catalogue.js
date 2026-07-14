const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireClusterAccess } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireClusterAccess('sales'));

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM service_catalogue ORDER BY id');
  res.json({ services: rows });
});

router.get('/gl-mappings', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM gl_mappings ORDER BY revenue_category');
  res.json({ glMappings: rows });
});

// Matches submitServiceForm — any Sales-cluster role can add/edit catalogue
// items in the original prototype (no extra role gate beyond cluster access).
router.post('/', async (req, res) => {
  const s = req.body || {};
  if (!s.id || !s.name || !s.category) {
    return res.status(400).json({ error: 'id, name, and category are required.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO service_catalogue
       (id, name, category, unit, nrc, mrc, tax, gl_code, revenue_category, cost, margin, sla, provisioning_owner, capacity_requirement)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, category=$3, unit=$4, nrc=$5, mrc=$6, tax=$7, gl_code=$8,
         revenue_category=$9, cost=$10, margin=$11, sla=$12, provisioning_owner=$13, capacity_requirement=$14
       RETURNING *`,
      [s.id, s.name, s.category, s.unit, s.nrc || 0, s.mrc || 0, s.tax || 17, s.glCode, s.revenueCategory, s.cost, s.margin, s.sla, s.provisioningOwner, s.capacityRequirement]
    );
    res.status(201).json({ service: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save service.' });
  }
});

module.exports = router;
