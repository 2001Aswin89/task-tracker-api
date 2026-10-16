const router = require('express').Router();
const { z } = require('zod');
const { pool, query } = require('../db/pool');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { requireTeamMember } = require('../services/access');
const { forbidden, notFound, conflict, badRequest } = require('../errors');

router.use(requireAuth);

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
});
const memberSchema = z.object({ email: z.string().trim().email() });

// Create a team; the creator becomes its owner. Both inserts share one transaction.
router.post('/', validate(createSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO teams (name, description, created_by) VALUES ($1, $2, $3) RETURNING *',
      [req.body.name, req.body.description ?? null, req.user.id]
    );
    await client.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')", [
      rows[0].id,
      req.user.id,
    ]);
    await client.query('COMMIT');
    res.status(201).json({ team: { ...rows[0], role: 'owner' } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT t.*, tm.role,
            (SELECT count(*)::int FROM team_members m WHERE m.team_id = t.id) AS member_count
       FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1
      ORDER BY t.created_at DESC`,
    [req.user.id]
  );
  res.json({ teams: rows });
});

router.get('/:id', async (req, res) => {
  const role = await requireTeamMember(req.params.id, req.user.id);
  const team = (await query('SELECT * FROM teams WHERE id = $1', [req.params.id])).rows[0];
  const members = (
    await query(
      `SELECT u.id, u.name, u.email, tm.role, tm.joined_at
         FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1 ORDER BY tm.joined_at`,
      [req.params.id]
    )
  ).rows;
  res.json({ team: { ...team, role }, members });
});

// Owners add an existing user by email (no email delivery in this project).
router.post('/:id/members', validate(memberSchema), async (req, res) => {
  const role = await requireTeamMember(req.params.id, req.user.id);
  if (role !== 'owner') throw forbidden('Only team owners can add members');
  const user = (await query('SELECT id, name, email FROM users WHERE lower(email) = lower($1)', [req.body.email])).rows[0];
  if (!user) throw notFound('User with that email');
  try {
    await query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')", [req.params.id, user.id]);
  } catch (err) {
    if (err.code === '23505') throw conflict('User is already a member of this team');
    throw err;
  }
  res.status(201).json({ member: { ...user, role: 'member' } });
});

// An owner can remove anyone; any member can remove themself (leave). The last owner cannot leave.
router.delete('/:id/members/:userId', async (req, res) => {
  const role = await requireTeamMember(req.params.id, req.user.id);
  const targetId = Number(req.params.userId);
  if (!Number.isInteger(targetId)) throw badRequest('Invalid user id');
  if (role !== 'owner' && targetId !== req.user.id) throw forbidden('Only owners can remove other members');
  const target = (
    await query('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [req.params.id, targetId])
  ).rows[0];
  if (!target) throw notFound('Member');
  if (target.role === 'owner') {
    const owners = (await query("SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'owner'", [req.params.id])).rows[0].n;
    if (owners <= 1) throw conflict('A team must keep at least one owner');
  }
  await query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [req.params.id, targetId]);
  // Tasks in this team assigned to the removed member become unassigned.
  await query('UPDATE tasks SET assignee_id = NULL, updated_at = now() WHERE team_id = $1 AND assignee_id = $2', [
    req.params.id,
    targetId,
  ]);
  res.status(204).end();
});

module.exports = router;
