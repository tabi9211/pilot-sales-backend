const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireClusterAccess } = require('../middleware/auth');
const { canAdvance, stageLabel } = require('../businessRules');
const { logAudit, addNotification, nextPrefixedId } = require('../utils');

const router = express.Router();
router.use(requireAuth, requireClusterAccess('delivery'));

const APPROVAL_CHAIN = ['Sales Manager', 'Finance Manager', 'Legal User'];

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, cu.name AS customer_name FROM contracts c
     JOIN customers cu ON cu.id = c.customer_id ORDER BY c.created_at DESC`
  );
  res.json({ contracts: rows });
});

// GET /api/contracts/eligible-leads — narrow, read-only list for the
// "Generate Contract/SOF" form's lead picker. Same reasoning as
// pipeline-demand in provisioning.js: the roles that view Contracts
// (Cloud Engineer/Cloud Manager/Legal User) don't have 'sales' cluster
// access, so they can't call listLeads(). This exposes only the minimal
// fields needed for the dropdown (id, customer name, value), gated by
// 'delivery' access (already applied via router.use above) instead.
router.get('/eligible-leads', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.est_value, cu.name AS customer_name FROM leads l
     JOIN customers cu ON cu.id = l.customer_id
     WHERE l.stage = 'customer_accepted' ORDER BY l.created_at DESC`
  );
  res.json({ eligibleLeads: rows });
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, cu.name AS customer_name FROM contracts c
     JOIN customers cu ON cu.id = c.customer_id WHERE c.id = $1`,
    [req.params.id]
  );
  const contract = rows[0];
  if (!contract) return res.status(404).json({ error: 'Contract not found.' });
  const { rows: approvals } = await pool.query(
    'SELECT * FROM approvals WHERE contract_id = $1 ORDER BY level', [req.params.id]
  );
  res.json({ contract, approvals });
});

// POST /api/contracts — matches submitContract() exactly: only from a lead
// in customer_accepted, computes totals from the latest proposal version
// (or falls back to lead.est_value if no proposal exists), auto-generates
// SOF/YYYY/#### contract number, and seeds the fixed 3-level approval chain.
router.post('/', async (req, res) => {
  const { leadId, startDate, termMonths } = req.body || {};
  if (!leadId || !startDate) {
    return res.status(400).json({ error: 'leadId and startDate are required.' });
  }

  const client = await pool.connect();
  try {
    const { rows: leadRows } = await client.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    const lead = leadRows[0];
    if (!lead) { return res.status(404).json({ error: 'Lead not found.' }); }
    if (lead.stage !== 'customer_accepted') {
      return res.status(409).json({ error: `A contract can only be generated from a lead in "Customer Accepted" stage. ${lead.id} is currently in "${stageLabel(lead.stage)}".` });
    }

    const { rows: propRows } = await client.query(
      'SELECT * FROM proposals WHERE lead_id = $1 ORDER BY version DESC LIMIT 1', [leadId]
    );
    const proposal = propRows[0] || null;
    let totalMRC = Number(lead.est_value);
    let totalNRC = 0;
    if (proposal) {
      const { rows: lineItems } = await client.query(
        'SELECT * FROM proposal_line_items WHERE proposal_id = $1', [proposal.id]
      );
      totalMRC = lineItems.reduce((s, li) => s + Number(li.rate) * Number(li.qty), 0);
      totalNRC = lineItems.reduce((s, li) => s + Number(li.nrc) * Number(li.qty), 0);
    }

    const term = parseInt(termMonths, 10) || 12;
    const endDt = new Date(startDate);
    endDt.setMonth(endDt.getMonth() + term);

    const { rows: countRows } = await client.query('SELECT COUNT(*)::int AS n FROM contracts');
    const year = new Date().getFullYear();
    const seq = String(countRows[0].n + 101).padStart(4, '0');
    const contractNumber = `SOF/${year}/${seq}`;

    const { rows: maxRows } = await client.query(
      `SELECT id FROM contracts ORDER BY (regexp_replace(id, '\\D', '', 'g'))::int DESC LIMIT 1`
    );
    const newId = nextPrefixedId('CNT-', maxRows[0]);

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO contracts (id, lead_id, proposal_id, contract_number, customer_id, start_date, end_date, status, total_mrc, total_nrc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending Approval',$8,$9)`,
      [newId, leadId, proposal ? proposal.id : null, contractNumber, lead.customer_id, startDate, endDt.toISOString().slice(0, 10), totalMRC, totalNRC]
    );

    const { rows: maxApprovalRows } = await client.query(
      `SELECT id FROM approvals ORDER BY (regexp_replace(id, '\\D', '', 'g'))::int DESC LIMIT 1`
    );
    let nextApprovalNum = maxApprovalRows[0]
      ? (parseInt(String(maxApprovalRows[0].id).replace(/\D/g, ''), 10) || 0) + 1
      : 1;

    for (let i = 0; i < APPROVAL_CHAIN.length; i++) {
      const role = APPROVAL_CHAIN[i];
      const { rows: userRows } = await client.query(
        `SELECT name FROM users WHERE role = $1 AND status = 'Active' LIMIT 1`, [role]
      );
      const approverName = userRows[0] ? userRows[0].name : role;
      await client.query(
        `INSERT INTO approvals (id, contract_id, level, approver_role, approver_name, status) VALUES ($1,$2,$3,$4,$5,'Pending')`,
        [`APR-${nextApprovalNum}`, newId, i + 1, role, approverName]
      );
      nextApprovalNum++;
    }

    const decision = canAdvance(lead.stage, 'contract_generated');
    if (decision) {
      await client.query(`UPDATE leads SET stage = 'contract_generated', stage_entered_at = now() WHERE id = $1`, [leadId]);
    }
    await logAudit(client, {
      userId: req.user.id, action: 'Create', entity: 'Contract/SOF', entityId: newId,
      details: `Generated ${contractNumber} for ${leadId}`,
    });
    await addNotification(client, { message: `Contract ${contractNumber} generated — pending internal approval.`, type: 'info' });
    await client.query('COMMIT');

    res.status(201).json({ contract: { id: newId, contractNumber, leadId, status: 'Pending Approval', totalMRC, totalNRC } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to generate contract.' });
  } finally {
    client.release();
  }
});

module.exports = router;
