const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query } = require('../db/pool');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { badRequest, conflict } = require('../errors');

router.use(requireAuth);

const COLUMNS = 'id, email, name, bio, created_at, updated_at';

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(254),
    bio: z.string().trim().max(500).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const passwordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

router.get('/me', async (req, res) => {
  const { rows } = await query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
  res.json({ user: rows[0] });
});

router.patch('/me', validate(updateSchema), async (req, res) => {
  const { name, email, bio } = req.body;
  try {
    const { rows } = await query(
      `UPDATE users
          SET name  = COALESCE($2, name),
              email = COALESCE($3, email),
              bio   = CASE WHEN $4::boolean THEN $5 ELSE bio END,
              updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [req.user.id, name ?? null, email ?? null, bio !== undefined, bio ?? null]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw conflict('An account with this email already exists');
    throw err;
  }
});

router.put('/me/password', validate(passwordSchema), async (req, res) => {
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(req.body.current_password, rows[0].password_hash))) {
    throw badRequest('Current password is incorrect');
  }
  const hash = await bcrypt.hash(req.body.new_password, 10);
  await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user.id, hash]);
  res.status(204).end();
});

module.exports = router;
