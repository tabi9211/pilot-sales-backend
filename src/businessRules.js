// ============================================================================
// SINGLE SOURCE OF TRUTH for Sales module business rules.
// This file never ships to the browser. The frontend has no copy of these
// rules — it only renders whatever the API returns and reacts to API errors.
// ============================================================================

const STAGES = ['New', 'Qualified', 'Proposal', 'Won', 'Lost'];

const ALLOWED_TRANSITIONS = {
  New: ['Qualified'],
  Qualified: ['Proposal'],
  Proposal: ['Won', 'Lost'],
  Won: [],
  Lost: [],
};

function getApprovalThreshold() {
  return Number(process.env.APPROVAL_THRESHOLD || 1000000);
}

function isValidTransition(currentStage, targetStage) {
  const allowed = ALLOWED_TRANSITIONS[currentStage];
  return Array.isArray(allowed) && allowed.includes(targetStage);
}

// A deal requires manager approval only when moving INTO "Won" above threshold.
function dealNeedsApproval(estValue, targetStage) {
  return targetStage === 'Won' && Number(estValue) > getApprovalThreshold();
}

// Central decision point. Every stage-change request in the API funnels
// through this function. Nothing about role or threshold logic exists
// anywhere in the frontend.
function evaluateTransition({ role, currentStage, targetStage, estValue }) {
  if (!STAGES.includes(targetStage)) {
    return { ok: false, status: 400, reason: 'Unknown target stage.' };
  }
  if (!isValidTransition(currentStage, targetStage)) {
    return {
      ok: false,
      status: 409,
      reason: `Cannot move a lead from "${currentStage}" to "${targetStage}".`,
    };
  }
  if (dealNeedsApproval(estValue, targetStage) && role !== 'sales_manager') {
    return {
      ok: false,
      status: 403,
      reason: `Deals above ${getApprovalThreshold().toLocaleString()} require Sales Manager approval before being marked Won.`,
      requiresApproval: true,
    };
  }
  return { ok: true };
}

module.exports = {
  STAGES,
  ALLOWED_TRANSITIONS,
  getApprovalThreshold,
  isValidTransition,
  dealNeedsApproval,
  evaluateTransition,
};
