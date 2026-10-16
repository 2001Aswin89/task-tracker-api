const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const { query } = require('../db/pool');
const { unauthorized } = require('../errors');

function signToken(userId) {
  return jwt.sign({}, config.jwtSecret, {
    subject: String(userId),
    expiresIn: config.jwtExpiresIn,
    jwtid: crypto.randomUUID(),
  });
}

/** Pull the bearer token from the Authorization header (or ?token= for EventSource, which cannot set headers). */
function extractToken(req) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.path.endsWith('/stream') && typeof req.query.token === 'string') return req.query.token;
  return null;
}

/** Verifies the JWT, rejects logged-out tokens, and sets req.user = { id, jti, exp }. */
async function requireAuth(req, _res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const revoked = await query('SELECT 1 FROM revoked_tokens WHERE jti = $1', [payload.jti]);
    if (revoked.rowCount) throw unauthorized('Token has been revoked');
    const user = await query('SELECT id FROM users WHERE id = $1', [payload.sub]);
    if (!user.rowCount) throw unauthorized('User no longer exists');
    req.user = { id: Number(payload.sub), jti: payload.jti, exp: payload.exp };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { signToken, requireAuth };
