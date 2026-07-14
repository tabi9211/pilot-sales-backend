// ============================================================================
// SINGLE SOURCE OF TRUTH — ported 1:1 from the prototype's core.js.
// This file never ships to the browser. Every rule here matches the
// client-side original exactly; nothing invented, nothing added.
// ============================================================================

// Full 16-stage lifecycle, tagged by cluster — matches core.js STAGES exactly.
const STAGES = [
  { id: 'lead_created',       label: 'Lead Created',            cluster: 'sales' },
  { id: 'qualified',          label: 'Qualified',               cluster: 'sales' },
  { id: 'solutioning',        label: 'Solutioning',             cluster: 'sales' },
  { id: 'proposal_created',   label: 'Proposal Created',        cluster: 'sales' },
  { id: 'negotiation',        label: 'Negotiation',             cluster: 'sales' },
  { id: 'customer_rejected',  label: 'Customer Rejected',       cluster: 'sales', terminal: true },
  { id: 'customer_accepted',  label: 'Customer Accepted',       cluster: 'sales' },
  { id: 'contract_generated', label: 'Contract/SOF Generated',  cluster: 'delivery' },
  { id: 'internal_approval',  label: 'Internal Approval',       cluster: 'delivery' },
  { id: 'work_order_created', label: 'Provisioning WO Created', cluster: 'delivery' },
  { id: 'installed',          label: 'Installed',               cluster: 'delivery' },
  { id: 'customer_uat',       label: 'Customer UAT',            cluster: 'delivery' },
  { id: 'uat_accepted',       label: 'UAT Accepted',            cluster: 'delivery' },
  { id: 'billing_triggered',  label: 'SAP Billing Triggered',   cluster: 'finance' },
  { id: 'billing_active',     label: 'Billing Active',          cluster: 'finance' },
  { id: 'revenue_tracked',    label: 'Revenue Tracked',         cluster: 'finance' },
];
const STAGE_ORDER = STAGES.map((s) => s.id);
function stageLabel(id) {
  const s = STAGES.find((x) => x.id === id);
  return s ? s.label : id;
}
function stageIndex(id) {
  return STAGE_ORDER.indexOf(id);
}

// Matches core.js ROLES exactly (order doesn't matter functionally, kept for parity).
const ROLES = [
  'System Admin', 'B2B Sales', 'Sales Manager', 'Cloud Engineer', 'Cloud Manager',
  'Finance User', 'Finance Manager', 'Legal User', 'Management', 'Customer User', 'Auditor',
];

// Matches core.js ROLE_ACCESS exactly — which clusters each role can reach.
// Enforced here on every request; the client never gets to decide this.
const ROLE_ACCESS = {
  'System Admin':    ['sales', 'delivery', 'sla', 'finance', 'ops', 'insights', 'admin'],
  'B2B Sales':       ['sales', 'ops'],
  'Sales Manager':   ['sales', 'ops', 'insights'],
  'Cloud Engineer':  ['delivery', 'sla'],
  'Cloud Manager':   ['delivery', 'sla', 'insights'],
  'Finance User':    ['finance'],
  'Finance Manager': ['finance', 'insights'],
  'Legal User':      ['delivery'],
  'Management':      ['insights', 'ops'],
  'Customer User':   ['ops'],
  'Auditor':         ['admin', 'insights'],
};

// Matches core.js CREATE_LEAD_ROLES exactly.
const CREATE_LEAD_ROLES = ['B2B Sales', 'Sales Manager', 'System Admin'];

function roleHasClusterAccess(role, cluster) {
  return (ROLE_ACCESS[role] || []).includes(cluster);
}

function canCreateLead(role) {
  return CREATE_LEAD_ROLES.includes(role);
}

// TIGHTENED beyond the original core.js rule, per explicit decision: the
// original StageEngine.canAdvance only checked that both stage IDs were
// valid — it never enforced sequence, relying entirely on the UI only
// showing the "correct" next-stage buttons. That was a silent gap once this
// became a real API (anyone could jump straight to any stage via a raw
// request). This version requires the target to be an actual allowed next
// step for the current stage, using the same NEXT_STAGE_OPTIONS map the UI
// draws its buttons from — so what the UI offers is now what the API allows,
// not just what it happens to display.
function canAdvance(currentStage, nextStage) {
  const ci = stageIndex(currentStage);
  const ni = stageIndex(nextStage);
  if (ni === -1 || ci === -1) return false;
  if (nextStage === 'billing_triggered' && currentStage !== 'uat_accepted') return false;
  const allowedNext = getNextStageOptions(currentStage).map((o) => o.id);
  return allowedNext.includes(nextStage);
}

// Matches core.js getNextStageOptions exactly — the Sales-cluster subset.
// (Delivery/Finance options get added here in later waves.) canAdvance()
// above now uses this map as the actual enforcement source, not just UI hints.
const NEXT_STAGE_OPTIONS = {
  lead_created:     [{ id: 'qualified', label: 'Mark Qualified' }],
  qualified:        [{ id: 'solutioning', label: 'Start Solutioning' }],
  solutioning:      [{ id: 'proposal_created', label: 'Proposal Created' }],
  proposal_created: [{ id: 'negotiation', label: 'Send to Negotiation' }],
  negotiation:      [
    { id: 'customer_accepted', label: 'Customer Accepted' },
    { id: 'customer_rejected', label: 'Customer Rejected' },
  ],
};
function getNextStageOptions(stage) {
  return NEXT_STAGE_OPTIONS[stage] || [];
}

module.exports = {
  STAGES,
  STAGE_ORDER,
  ROLES,
  ROLE_ACCESS,
  CREATE_LEAD_ROLES,
  stageLabel,
  stageIndex,
  roleHasClusterAccess,
  canCreateLead,
  canAdvance,
  getNextStageOptions,
};
