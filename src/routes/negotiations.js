const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireClusterAccess } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireClusterAccess('sales'));

function nextNegId(maxIdRow) {
  const max = maxIdRow ? parseInt(String(maxIdRow.id).replace(/\D/g, ''), 10) || 0 : 0;
  return 'NEG-' + String(max + 1).padStart(2, '0');
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM negotiations ORDER BY created_at DESC');
  res.json({ negotiations: rows });
});

router.post('/', async (req, res) => {
  const { proposalId, requestedChanges, status } = req.body || {};
  if (!proposalId) {
    return res.status(400).json({ error: 'proposalId is required.' });
  }

  const client = await pool.connect();
  try {
    const propCheck = await client.query('SELECT id FROM proposals WHERE id = $1', [proposalId]);
    if (!propCheck.rows[0]) {
      client.release();
      return res.status(404).json({ error: 'Proposal not found.' });
    }
    const { rows: existingRounds } = await client.query(
      'SELECT id FROM negotiations WHERE proposal_id = $1', [proposalId]
    );
    const { rows: maxRows } = await client.query(
      `SELECT id FROM negotiations ORDER BY (regexp_replace(id, '\\D', '', 'g'))::int DESC LIMIT 1`
    );
    const newId = nextNegId(maxRows[0]);
    const round = existingRounds.length + 1;
    const finalStatus = ['Pending', 'Countered', 'Accepted', 'Rejected'].includes(status) ? status : 'Pending';

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO negotiations (id, proposal_id, round, requested_changes, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [newId, proposalId, round, requestedChanges || '', finalStatus]
    );
    await client.query(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, 'Create', 'Negotiation Round', newId, `Round ${round} logged for ${proposalId} — ${finalStatus}`]
    );
    await client.query('COMMIT');
    res.status(201).json({ negotiation: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to log negotiation round.' });
  } finally {
    client.release();
  }
});

module.exports = router;
