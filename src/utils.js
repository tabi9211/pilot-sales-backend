async function logAudit(client, { userId, action, entity, entityId, details }) {
  await client.query(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
    [userId, action, entity, entityId, details]
  );
}
async function addNotification(client, { message, type }) {
  await client.query('INSERT INTO notifications (message, type) VALUES ($1,$2)', [message, type || 'info']);
}
function nextPrefixedId(prefix, maxIdRow, startAt) {
  const max = maxIdRow ? parseInt(String(maxIdRow.id).replace(/\D/g, ''), 10) || 0 : 0;
  return prefix + (max + 1 <= (startAt || 1) ? (startAt || 1) : max + 1);
}

module.exports = { logAudit, addNotification, nextPrefixedId };
