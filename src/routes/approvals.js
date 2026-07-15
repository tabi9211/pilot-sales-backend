const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { canAdvance, canDecideApproval, roleHasClusterAccess } = require('../businessRules');
const { logAudit, addNotification, nextPrefixedId } = require('../utils');

const router = express.Router();
router.use(requireAuth);

// Access carve-out (agreed fix): normally a module requires general
// 'delivery' cluster access. But the approval chain includes 'Sales Manager'
// as level 1, and Sales Manager does NOT have 'delivery' cluster access in
// ROLE_ACCESS — so without this carve-out they could never reach their own
// approval. Anyone with real delivery access, System Admin, or anyone who is
// one of the three fixed chain roles (Sales Manager/Finance Manager/Legal
// User) can view the list; deciding a specific approval is separately
// gated below by canDecideApproval (role must actually match that row).
const APPROVAL_CHAIN_ROLES = ['Sales Manager', 'Finance Manager', 'Legal User'];
function canAccessApprovalsModule(role) {
  return roleHasClusterAccess(role, 'delivery') || role === 'System Admin' || APPROVAL_CHAIN_ROLES.includes(role);
}
router.use((req, res, next) => {
  if (!canAccessApprovalsModule(req.user.role)) {
    return res.status(403).json({ error: `${req.user.role} does not have access to the Approval Workflow.` });
  }
  next();
});

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, c.contract_number FROM approvals a
     JOIN contracts c ON c.id = a.contract_id ORDER BY a.id`
  );
  res.json({ approvals: rows });
});

// POST /api/approvals/:id/decide — matches decideApproval() exactly, plus
// the agreed role-match gate (canDecideApproval) that the original never had.
router.post('/:id/decide', async (req, res) => {
  const { decision, comments } = req.body || {};
  if (!['Approved', 'Rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "Approved" or "Rejected".' });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM approvals WHERE id = $1', [req.params.id]);
    const approval = rows[0];
    if (!approval) { return res.status(404).json({ error: 'Approval not found.' }); }
    if (approval.status !== 'Pending') {
      return res.status(409).json({ error: `This approval has already been decided (${approval.status}).` });
    }
    if (!canDecideApproval(req.user.role, approval.approver_role)) {
      return res.status(403).json({ error: `Only ${approval.approver_role} (or System Admin) can decide this approval.` });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE approvals SET status = $1, decided_at = CURRENT_DATE, comments = $2 WHERE id = $3`,
      [decision, comments || null, req.params.id]
    );
    await logAudit(client, {
      userId: req.user.id, action: decision, entity: 'Approval', entityId: req.params.id,
      details: `${approval.approver_role} ${decision.toLowerCase()} level ${approval.level} for contract ${approval.contract_id}`,
    });

    const { rows: contractRows } = await client.query('SELECT * FROM contracts WHERE id = $1', [approval.contract_id]);
    const contract = contractRows[0];

    if (decision === 'Rejected') {
      await client.query(`UPDATE contracts SET status = 'Rejected' WHERE id = $1`, [contract.id]);
      await addNotification(client, { message: `Contract ${contract.contract_number} rejected at approval level ${approval.level}.`, type: 'danger' });
    } else {
      const { rows: chain } = await client.query('SELECT status FROM approvals WHERE contract_id = $1', [contract.id]);
      const allApproved = chain.every((a) => a.status === 'Approved');
      if (allApproved) {
        await client.query(`UPDATE contracts SET status = 'Approved' WHERE id = $1`, [contract.id]);

        const { rows: leadRows } = await client.query('SELECT * FROM leads WHERE id = $1', [contract.lead_id]);
        const lead = leadRows[0];
        if (lead && canAdvance(lead.stage, 'internal_approval')) {
          await client.query(`UPDATE leads SET stage = 'internal_approval', stage_entered_at = now() WHERE id = $1`, [lead.id]);
        }

        const { rows: existingWO } = await client.query('SELECT id FROM work_orders WHERE contract_id = $1', [contract.id]);
        if (!existingWO.length) {
          const { rows: maxWoRows } = await client.query(
            `SELECT id FROM work_orders ORDER BY (regexp_replace(id, '\\D', '', 'g'))::int DESC LIMIT 1`
          );
          const newWoId = nextPrefixedId('WO-', maxWoRows[0]);
          const target = new Date(); target.setDate(target.getDate() + 10);

          await client.query(
            `INSERT INTO work_orders (id, contract_id, assigned_engineer, status, target_install_date) VALUES ($1,$2,'Usman Tariq','Open',$3)`,
            [newWoId, contract.id, target.toISOString().slice(0, 10)]
          );
          if (contract.proposal_id) {
            const { rows: lineItems } = await client.query('SELECT sku_id, qty FROM proposal_line_items WHERE proposal_id = $1', [contract.proposal_id]);
            for (const li of lineItems) {
              await client.query('INSERT INTO work_order_services (work_order_id, sku_id, qty) VALUES ($1,$2,$3)', [newWoId, li.sku_id, li.qty]);
            }
          }
          const { rows: leadRows2 } = await client.query('SELECT * FROM leads WHERE id = $1', [contract.lead_id]);
          const lead2 = leadRows2[0];
          if (lead2 && canAdvance(lead2.stage, 'work_order_created')) {
            await client.query(`UPDATE leads SET stage = 'work_order_created', stage_entered_at = now() WHERE id = $1`, [lead2.id]);
          }
          await logAudit(client, {
            userId: req.user.id, action: 'Create', entity: 'Work Order', entityId: newWoId,
            details: `Auto-created from approved contract ${contract.contract_number}`,
          });
        }
        await addNotification(client, { message: `Contract ${contract.contract_number} fully approved — provisioning work order created automatically.`, type: 'info' });
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to record approval decision.' });
  } finally {
    client.release();
  }
});

module.exports = router;
