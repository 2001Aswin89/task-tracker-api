const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query } = require('../db/pool');
const { validate } = require('../middleware/validate');
const { signToken, requireAuth } = require('../middleware/auth');
const { unauthorized, conflict } = require('../errors');

const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});
const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) });

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, bio: u.bio, created_at: u.created_at });

router.post('/register', validate(registerSchema), async (req, res) => {
  const { email, name, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *',
      [email, name, hash]
    );
    res.status(201).json({ user: publicUser(rows[0]), token: signToken(rows[0].id) });
  } catch (err) {
    if (err.code === '23505') throw conflict('An account with this email already exists');
    throw err;
  }
});

router.post('/login', validate(loginSchema), async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE lower(email) = lower($1)', [req.body.email]);
  const user = rows[0];
  // Same message for unknown email and wrong password so accounts cannot be enumerated.
  const ok = user && (await bcrypt.compare(req.body.password, user.password_hash));
  if (!ok) throw unauthorized('Invalid email or password');
  res.json({ user: publicUser(user), token: signToken(user.id) });
});

// JWTs are stateless, so logout stores the token id until its natural expiry.
router.post('/logout', requireAuth, async (req, res) => {
  await query(
    `INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, to_timestamp($2))
     ON CONFLICT (jti) DO NOTHING`,
    [req.user.jti, req.user.exp]
  );
  await query('DELETE FROM revoked_tokens WHERE expires_at < now()');
  res.status(204).end();
});

module.exports = router;
