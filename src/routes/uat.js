const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireClusterAccess } = require('../middleware/auth');
const { canAdvance } = require('../businessRules');
const { logAudit, addNotification, nextPrefixedId } = require('../utils');

const router = express.Router();
router.use(requireAuth, requireClusterAccess('delivery'));

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM uat_records ORDER BY test_date DESC');
  res.json({ uatRecords: rows });
});

// POST /api/uat/schedule — matches scheduleUAT(): target date = today+2,
// advances lead to 'customer_uat'.
router.post('/schedule', async (req, res) => {
  const { workOrderId } = req.body || {};
  if (!workOrderId) return res.status(400).json({ error: 'workOrderId is required.' });

  const client = await pool.connect();
  try {
    const { rows: woRows } = await client.query('SELECT * FROM work_orders WHERE id = $1', [workOrderId]);
    const wo = woRows[0];
    if (!wo) { return res.status(404).json({ error: 'Work order not found.' }); }
    if (wo.status !== 'Installed') {
      return res.status(409).json({ error: 'UAT can only be scheduled for an Installed work order.' });
    }
    const { rows: existing } = await client.query('SELECT id FROM uat_records WHERE work_order_id = $1', [workOrderId]);
    if (existing.length) { return res.status(409).json({ error: 'UAT is already scheduled for this work order.' }); }

    const { rows: maxRows } = await client.query(
      `SELECT id FROM uat_records ORDER BY (regexp_replace(id, '\\D', '', 'g'))::int DESC LIMIT 1`
    );
    const newId = nextPrefixedId('UAT-', maxRows[0]);
    const target = new Date(); target.setDate(target.getDate() + 2);

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO uat_records (id, work_order_id, test_date, result) VALUES ($1,$2,$3,'Pending')`,
      [newId, workOrderId, target.toISOString().slice(0, 10)]
    );

    const { rows: contractRows } = await client.query('SELECT * FROM contracts WHERE id = $1', [wo.contract_id]);
    const { rows: leadRows } = await client.query('SELECT * FROM leads WHERE id = $1', [contractRows[0].lead_id]);
    const lead = leadRows[0];
    if (lead && canAdvance(lead.stage, 'customer_uat')) {
      await client.query(`UPDATE leads SET stage = 'customer_uat', stage_entered_at = now() WHERE id = $1`, [lead.id]);
    }
    await logAudit(client, {
      userId: req.user.id, action: 'Create', entity: 'UAT', entityId: newId,
      details: `UAT scheduled for ${workOrderId}`,
    });
    await client.query('COMMIT');
    res.status(201).json({ uatRecord: { id: newId, workOrderId, testDate: target.toISOString().slice(0, 10), result: 'Pending' } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to schedule UAT.' });
  } finally {
    client.release();
  }
});

// POST /api/uat/:id/decide — matches decideUAT(): Accepted advances to
// uat_accepted; Rejected loops back to installed (both routed through the
// standard canAdvance-validated path, since customer_uat -> installed is
// explicitly allowed in NEXT_STAGE_OPTIONS for exactly this loop-back case).
router.post('/:id/decide', async (req, res) => {
  const { result, comments } = req.body || {};
  if (!['Accepted', 'Rejected'].includes(result)) {
    return res.status(400).json({ error: 'result must be "Accepted" or "Rejected".' });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM uat_records WHERE id = $1', [req.params.id]);
    const uat = rows[0];
    if (!uat) { return res.status(404).json({ error: 'UAT record not found.' }); }
    if (uat.result !== 'Pending') { return res.status(409).json({ error: `This UAT has already been decided (${uat.result}).` }); }

    await client.query('BEGIN');
    await client.query(`UPDATE uat_records SET result = $1, comments = $2 WHERE id = $3`, [result, comments || null, req.params.id]);
    await logAudit(client, {
      userId: req.user.id, action: result, entity: 'UAT', entityId: req.params.id,
      details: `UAT ${result.toLowerCase()} for ${uat.work_order_id}`,
    });

    const { rows: woRows } = await client.query('SELECT * FROM work_orders WHERE id = $1', [uat.work_order_id]);
    const { rows: contractRows } = await client.query('SELECT * FROM contracts WHERE id = $1', [woRows[0].contract_id]);
    const { rows: leadRows } = await client.query('SELECT * FROM leads WHERE id = $1', [contractRows[0].lead_id]);
    const lead = leadRows[0];

    if (result === 'Accepted' && lead && canAdvance(lead.stage, 'uat_accepted')) {
      await client.query(`UPDATE leads SET stage = 'uat_accepted', stage_entered_at = now() WHERE id = $1`, [lead.id]);
      await addNotification(client, { message: `UAT accepted for ${woRows[0].id}. Billing can now be triggered in SAP AR.`, type: 'info' });
    } else if (result === 'Rejected' && lead && canAdvance(lead.stage, 'installed')) {
      await client.query(`UPDATE leads SET stage = 'installed', stage_entered_at = now() WHERE id = $1`, [lead.id]);
      await logAudit(client, {
        userId: req.user.id, action: 'Stage Change', entity: 'Lead/Opportunity', entityId: lead.id,
        details: 'UAT rejected — looped back to Installed for rework',
      });
      await addNotification(client, { message: `UAT rejected for ${woRows[0].id}. Looped back to Installed for rework.`, type: 'danger' });
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to record UAT decision.' });
  } finally {
    client.release();
  }
});

module.exports = router;
