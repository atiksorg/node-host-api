// api/middleware/auth.js
// Bearer token авторизация

const config = require('../config');

function auth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  if (token !== config.MASTER_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  next();
}

module.exports = auth;
