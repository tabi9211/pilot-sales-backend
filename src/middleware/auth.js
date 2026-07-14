const jwt = require('jsonwebtoken');
const { roleHasClusterAccess } = require('../businessRules');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, username: payload.username, name: payload.name, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// Enforces ROLE_ACCESS server-side — matches core.js navigateTo()'s access
// check exactly, but here it's unbypassable (the original was cosmetic:
// hidden from the sidebar, but not actually blocked at the data layer).
function requireClusterAccess(cluster) {
  return (req, res, next) => {
    if (!req.user || !roleHasClusterAccess(req.user.role, cluster)) {
      return res.status(403).json({
        error: `${req.user ? req.user.role : 'This role'} does not have access to "${cluster}".`,
      });
    }
    next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireClusterAccess, requireRole };
