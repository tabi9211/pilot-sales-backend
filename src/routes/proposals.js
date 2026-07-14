const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireClusterAccess } = require('../middleware/auth');
const { stageIndex, stageLabel } = require('../businessRules');

const router = express.Router();
router.use(requireAuth, requireClusterAccess('sales'));

async function logAudit(client, { userId, action, entity, entityId, details }) {
  await client.query(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
    [userId, action, entity, entityId, details]
  );
}
async function addNotification(client, { message, type }) {
  await client.query('INSERT INTO notifications (message, type) VALUES ($1,$2)', [message, type || 'info']);
}
function nextProposalId(maxIdRow) {
  const max = maxIdRow ? parseInt(String(maxIdRow.id).replace(/\D/g, ''), 10) || 0 : 0;
  return 'PRO-' + (max + 1 <= 5000 ? 5001 : max + 1);
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM proposals ORDER BY created_at DESC');
  res.json({ proposals: rows });
});

// GET /api/proposals/:id — full detail with line items, matches viewProposal()
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
  const proposal = rows[0];
  if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
  const { rows: lineItems } = await pool.query(
    `SELECT pli.*, sc.name AS service_name FROM proposal_line_items pli
     JOIN service_catalogue sc ON sc.id = pli.sku_id WHERE pli.proposal_id = $1`,
    [req.params.id]
  );
  res.json({ proposal, lineItems });
});

// POST /api/proposals — matches submitProposal() exactly, including the
// side effect: if the lead hasn't reached proposal_created yet, advance it.
router.post('/', async (req, res) => {
  const { leadId, lineItems } = req.body || {};
  if (!leadId || !Array.isArray(lineItems) || !lineItems.length) {
    return res.status(400).json({ error: 'leadId and at least one line item are required.' });
  }

  const client = await pool.connect();
  try {
    const { rows: leadRows } = await client.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    const lead = leadRows[0];
    if (!lead) {
      client.release();
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const { rows: existingForLead } = await client.query(
      'SELECT id FROM proposals WHERE lead_id = $1', [leadId]
    );
    const { rows: maxRows } = await client.query(
      `SELECT id FROM proposals ORDER BY (regexp_replace(id, '\\D', '', 'g'))::int DESC LIMIT 1`
    );
    const newId = nextProposalId(maxRows[0]);
    const version = existingForLead.length + 1;

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO proposals (id, lead_id, version, status) VALUES ($1,$2,$3,'Sent')`,
      [newId, leadId, version]
    );
    for (const li of lineItems) {
      await client.query(
        `INSERT INTO proposal_line_items (proposal_id, sku_id, qty, rate, nrc) VALUES ($1,$2,$3,$4,$5)`,
        [newId, li.skuId, li.qty, li.rate, li.nrc]
      );
    }

    // Matches: if (lead && stageIndex(lead.stage) < stageIndex('proposal_created')) StageEngine.advance(...)
    if (stageIndex(lead.stage) < stageIndex('proposal_created')) {
      await client.query(`UPDATE leads SET stage = 'proposal_created', stage_entered_at = now() WHERE id = $1`, [leadId]);
      await logAudit(client, {
        userId: req.user.id, action: 'Stage Change', entity: 'Lead/Opportunity', entityId: leadId,
        details: `${stageLabel(lead.stage)} → ${stageLabel('proposal_created')} — Proposal ${newId} created`,
      });
    }

    await logAudit(client, {
      userId: req.user.id, action: 'Create', entity: 'Proposal', entityId: newId,
      details: `Proposal created for ${leadId} (v${version})`,
    });
    await addNotification(client, { message: `Proposal ${newId} created for ${leadId}.`, type: 'info' });
    await client.query('COMMIT');

    res.status(201).json({ proposal: { id: newId, leadId, version, status: 'Sent' } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to create proposal.' });
  } finally {
    client.release();
  }
});

module.exports = router;
