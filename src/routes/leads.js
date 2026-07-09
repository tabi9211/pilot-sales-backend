const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { evaluateTransition, getApprovalThreshold, STAGES } = require('../businessRules');

const router = express.Router();

async function logAudit(client, { leadId, userId, action, detail }) {
  await client.query(
    'INSERT INTO audit_log (lead_id, user_id, action, detail) VALUES ($1, $2, $3, $4)',
    [leadId, userId, action, detail]
  );
}

// Everything below requires a valid JWT. No route returns data without it.
router.use(requireAuth);

// GET /api/leads — both roles can view all leads
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, u.username AS owner_username, a.username AS approved_by_username
     FROM leads l
     JOIN users u ON u.id = l.owner_id
     LEFT JOIN users a ON a.id = l.approved_by
     ORDER BY l.created_at DESC`
  );
  res.json({ leads: rows, meta: { approvalThreshold: getApprovalThreshold(), stages: STAGES } });
});

// POST /api/leads — both roles can create leads
router.post('/', async (req, res) => {
  const { customerName, contactName, estValue } = req.body || {};
  if (!customerName || typeof estValue === 'undefined') {
    return res.status(400).json({ error: 'customerName and estValue are required.' });
  }
  const value = Number(estValue);
  if (Number.isNaN(value) || value < 0) {
    return res.status(400).json({ error: 'estValue must be a non-negative number.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO leads (customer_name, contact_name, est_value, stage, owner_id)
       VALUES ($1, $2, $3, 'New', $4) RETURNING *`,
      [customerName, contactName || null, value, req.user.id]
    );
    const lead = rows[0];
    await logAudit(client, {
      leadId: lead.id,
      userId: req.user.id,
      action: 'create',
      detail: `Lead created for ${customerName}`,
    });
    await client.query('COMMIT');
    res.status(201).json({ lead });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to create lead.' });
  } finally {
    client.release();
  }
});

// POST /api/leads/:id/advance — the core enforcement point.
// role, current stage, target stage, and deal value are all re-checked
// against the DB record on the server; nothing is trusted from the client
// except "which lead" and "which stage they're requesting".
router.post('/:id/advance', async (req, res) => {
  const leadId = Number(req.params.id);
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

    const decision = evaluateTransition({
      role: req.user.role,
      currentStage: lead.stage,
      targetStage,
      estValue: lead.est_value,
    });

    if (!decision.ok) {
      return res.status(decision.status).json({
        error: decision.reason,
        requiresApproval: !!decision.requiresApproval,
      });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE leads SET stage = $1, updated_at = now() WHERE id = $2`,
      [targetStage, leadId]
    );
    await logAudit(client, {
      leadId,
      userId: req.user.id,
      action: 'stage_change',
      detail: `${lead.stage} -> ${targetStage}`,
    });
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

// POST /api/leads/:id/manager-approve — manager-only. Approves a high-value
// deal sitting in Proposal and moves it straight to Won. requireRole is
// enforced here on the server; the button only being *visible* to managers
// on the frontend is cosmetic, not the actual security boundary.
router.post('/:id/manager-approve', requireRole('sales_manager'), async (req, res) => {
  const leadId = Number(req.params.id);
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    const lead = rows[0];
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    if (lead.stage !== 'Proposal') {
      return res.status(409).json({ error: `Lead must be in Proposal stage to approve. Currently: ${lead.stage}.` });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE leads
       SET stage = 'Won', approval_status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2`,
      [req.user.id, leadId]
    );
    await logAudit(client, {
      leadId,
      userId: req.user.id,
      action: 'manager_approve',
      detail: `Approved and moved to Won (value ${lead.est_value})`,
    });
    await client.query('COMMIT');

    const updated = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    res.json({ lead: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to approve lead.' });
  } finally {
    client.release();
  }
});

module.exports = router;
