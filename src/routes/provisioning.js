const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireClusterAccess } = require('../middleware/auth');
const { canAdvance } = require('../businessRules');
const { logAudit, addNotification } = require('../utils');

const router = express.Router();
router.use(requireAuth, requireClusterAccess('delivery'));

router.get('/', async (req, res) => {
  const { rows: workOrders } = await pool.query(
    `SELECT w.*, c.contract_number FROM work_orders w JOIN contracts c ON c.id = w.contract_id ORDER BY w.created_date DESC`
  );
  const { rows: services } = await pool.query(
    `SELECT wos.*, sc.name AS service_name, sc.category FROM work_order_services wos
     JOIN service_catalogue sc ON sc.id = wos.sku_id`
  );
  const withServices = workOrders.map((w) => ({
    ...w,
    services: services.filter((s) => s.work_order_id === w.id),
  }));
  res.json({ workOrders: withServices });
});

router.get('/capacity-pool', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM capacity_pool ORDER BY resource');
  res.json({ capacityPool: rows });
});

// GET /api/work-orders/pipeline-demand — narrow, read-only aggregate for the
// Capacity Planning tab's "forecasted demand" widget. Deliberately NOT the
// full /api/leads endpoint: Cloud Engineer/Cloud Manager/Legal User (the
// roles that actually view Provisioning) don't have 'sales' cluster access,
// so they can't call listLeads(). Rather than widen their cluster access
// broadly just for this one widget, this exposes only a count + total value,
// no individual lead records, no customer/contact details.
router.get('/pipeline-demand', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS open_count, COALESCE(SUM(est_value), 0) AS open_value
     FROM leads WHERE stage != 'customer_rejected'`
  );
  res.json({ openCount: rows[0].open_count, openValue: Number(rows[0].open_value) });
});

const CAPACITY_BUMP_RULES = {
  Compute: [{ resource: 'CPU (vCores)', perQty: 4 }, { resource: 'RAM (GB)', perQty: 16 }],
  Storage: [{ resource: 'Storage (TB)', perQty: 1 }],
  Backup: [{ resource: 'Backup Capacity (TB)', perQty: 1 }],
  Firewall: [{ resource: 'Firewall Instances', perQty: 1 }],
};

// POST /api/work-orders/:id/mark-installed — matches markInstalled() exactly:
// flips status, bumps capacity pool per service category (capped at total),
// and advances the lead to 'installed'.
router.post('/:id/mark-installed', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM work_orders WHERE id = $1', [req.params.id]);
    const wo = rows[0];
    if (!wo) { return res.status(404).json({ error: 'Work order not found.' }); }
    if (wo.status === 'Installed') { return res.status(409).json({ error: 'This work order is already marked Installed.' }); }

    const { rows: services } = await client.query(
      `SELECT wos.qty, sc.category FROM work_order_services wos
       JOIN service_catalogue sc ON sc.id = wos.sku_id WHERE wos.work_order_id = $1`,
      [req.params.id]
    );

    await client.query('BEGIN');
    await client.query(`UPDATE work_orders SET status = 'Installed' WHERE id = $1`, [wo.id]);

    for (const svc of services) {
      const bumps = CAPACITY_BUMP_RULES[svc.category] || [];
      for (const bump of bumps) {
        await client.query(
          `UPDATE capacity_pool SET used = LEAST(total, used + $1) WHERE resource = $2`,
          [bump.perQty * Number(svc.qty), bump.resource]
        );
      }
    }

    const { rows: contractRows } = await client.query('SELECT * FROM contracts WHERE id = $1', [wo.contract_id]);
    const contract = contractRows[0];
    const { rows: leadRows } = await client.query('SELECT * FROM leads WHERE id = $1', [contract.lead_id]);
    const lead = leadRows[0];
    if (lead && canAdvance(lead.stage, 'installed')) {
      await client.query(`UPDATE leads SET stage = 'installed', stage_entered_at = now() WHERE id = $1`, [lead.id]);
    }

    await logAudit(client, {
      userId: req.user.id, action: 'Update', entity: 'Work Order', entityId: wo.id,
      details: 'Marked as Installed; capacity pool updated',
    });
    await addNotification(client, { message: `${wo.id} installed. Customer UAT can now begin.`, type: 'info' });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to mark work order installed.' });
  } finally {
    client.release();
  }
});

module.exports = router;
