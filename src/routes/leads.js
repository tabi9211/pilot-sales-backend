const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireClusterAccess } = require('../middleware/auth');
const { canCreateLead, canAdvance, getNextStageOptions, stageLabel } = require('../businessRules');

const router = express.Router();

async function logAudit(client, { userId, action, entity, entityId, details }) {
  await client.query(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
    [userId, action, entity, entityId, details]
  );
}
async function addNotification(client, { userId, message, type }) {
  await client.query(
    'INSERT INTO notifications (user_id, message, type) VALUES ($1,$2,$3)',
    [userId || null, message, type || 'info']
  );
}
function nextLeadId(maxIdRow) {
  const max = maxIdRow ? parseInt(String(maxIdRow.id).replace(/\D/g, ''), 10) || 0 : 0;
  return 'L-' + (max + 1 <= 1000 ? 1001 : max + 1);
}

router.use(requireAuth, requireClusterAccess('sales'));

// GET /api/leads — Sales-cluster roles only (enforced above), returns all leads
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, c.name AS customer_name, u.name AS owner_name
     FROM leads l
     JOIN customers c ON c.id = l.customer_id
     JOIN users u ON u.id = l.owner_id
     ORDER BY l.created_at DESC`
  );
  res.json({ leads: rows });
});

// POST /api/leads — role-gated to CREATE_LEAD_ROLES, matches canCreateLead() exactly
router.post('/', async (req, res) => {
  if (!canCreateLead(req.user.role)) {
    return res.status(403).json({ error: 'Your role is not permitted to create leads.' });
  }
  const { customerId, contactName, source, estValue } = req.body || {};
  if (!customerId || typeof estValue === 'undefined') {
    return res.status(400).json({ error: 'customerId and estValue are required.' });
  }
  const value = Number(estValue);
  if (Number.isNaN(value) || value < 0) {
    return res.status(400).json({ error: 'estValue must be a non-negative number.' });
  }

  const client = await pool.connect();
  try {
    const custCheck = await client.query('SELECT name FROM customers WHERE id = $1', [customerId]);
    if (!custCheck.rows[0]) {
      client.release();
      return res.status(400).json({ error: 'Unknown customerId.' });
    }

    const { rows: maxRows } = await client.query(
      `SELECT id FROM leads ORDER BY (regexp_replace(id, '\\D', '', 'g'))::int DESC LIMIT 1`
    );
    const newId = nextLeadId(maxRows[0]);

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO leads (id, customer_id, contact_name, source, est_value, stage, owner_id)
       VALUES ($1,$2,$3,$4,$5,'lead_created',$6) RETURNING *`,
      [newId, customerId, contactName || null, source || null, value, req.user.id]
    );
    const lead = rows[0];
    await logAudit(client, {
      userId: req.user.id, action: 'Create', entity: 'Lead/Opportunity', entityId: lead.id,
      details: `New lead created for ${custCheck.rows[0].name}${source ? ' via ' + source : ''}`,
    });
    await addNotification(client, { message: `New lead ${lead.id} created for ${custCheck.rows[0].name}.`, type: 'info' });
    await client.query('COMMIT');
    res.status(201).json({ lead });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to create lead.' });
  } finally {
    client.release();
  }
});

// POST /api/leads/:id/advance — matches StageEngine.advance() exactly,
// re-validated server-side against the CURRENT stage in the database.
router.post('/:id/advance', async (req, res) => {
  const leadId = req.params.id;
  const { targetStage } = req.body || {};
  if (!targetStage) {
    return res.status(400).json({ error: 'targetStage is required.' });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    const lead = rows[0];
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    if (!canAdvance(lead.stage, targetStage)) {
      return res.status(409).json({
        error: `Cannot move ${lead.id} to "${stageLabel(targetStage)}" from "${stageLabel(lead.stage)}".`,
      });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE leads SET stage = $1, stage_entered_at = now() WHERE id = $2`,
      [targetStage, leadId]
    );
    await logAudit(client, {
      userId: req.user.id, action: 'Stage Change', entity: 'Lead/Opportunity', entityId: lead.id,
      details: `${stageLabel(lead.stage)} → ${stageLabel(targetStage)}`,
    });
    await addNotification(client, { message: `${lead.id} moved to "${stageLabel(targetStage)}".`, type: 'info' });
    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    res.json({ lead: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to advance lead.' });
  } finally {
    client.release();
  }
});

// GET /api/leads/:id/next-stage-options — UI convenience only (matches
// getNextStageOptions), NOT a security boundary — /advance re-checks everything.
router.get('/:id/next-stage-options', async (req, res) => {
  const { rows } = await pool.query('SELECT stage FROM leads WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ options: getNextStageOptions(rows[0].stage) });
});

module.exports = router;
