const router = require('express').Router();
const { z } = require('zod');
const { query } = require('../db/pool');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { requireTeamMember, getAccessibleTask, teamRole } = require('../services/access');
const { notify } = require('../services/notifier');
const { forbidden, badRequest } = require('../errors');

router.use(requireAuth);

const id = z.coerce.number().int().positive();
const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Must be an ISO 8601 date or datetime, e.g. 2026-12-31 or 2026-12-31T17:00:00Z');
const STATUSES = ['open', 'in_progress', 'completed'];
const PRIORITIES = ['low', 'medium', 'high'];

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  due_date: isoDate.optional(),
  priority: z.enum(PRIORITIES).optional(),
  team_id: id.optional(),
  assignee_id: id.optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable(),
    due_date: isoDate.nullable(),
    priority: z.enum(PRIORITIES),
    status: z.enum(STATUSES),
    assignee_id: id.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  team_id: id.optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), id]).optional(),
  created_by: z.union([z.literal('me'), id]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  due_before: isoDate.optional(),
  due_after: isoDate.optional(),
  sort: z.enum(['created_at', 'due_date', 'priority', 'title', 'status']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: id.default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Assignee rules: team tasks may only go to team members; personal tasks only to their creator. */
async function assertAssignable(task, assigneeId) {
  if (assigneeId == null) return;
  if (task.team_id) {
    if (!(await teamRole(task.team_id, assigneeId))) throw badRequest('Assignee must be a member of the task\'s team');
  } else if (assigneeId !== task.created_by) {
    throw badRequest('Personal tasks (no team) can only be assigned to their creator');
  }
}

router.post('/', validate(createSchema), async (req, res) => {
  const b = req.body;
  if (b.team_id) await requireTeamMember(b.team_id, req.user.id);
  await assertAssignable({ team_id: b.team_id ?? null, created_by: req.user.id }, b.assignee_id);
  const { rows } = await query(
    `INSERT INTO tasks (title, description, due_date, priority, team_id, created_by, assignee_id)
     VALUES ($1, $2, $3, COALESCE($4, 'medium'), $5, $6, $7) RETURNING *`,
    [b.title, b.description ?? null, b.due_date ?? null, b.priority ?? null, b.team_id ?? null, req.user.id, b.assignee_id ?? null]
  );
  const task = rows[0];
  await notify(task.assignee_id, req.user.id, {
    type: 'task_assigned',
    taskId: task.id,
    message: `You were assigned the task "${task.title}"`,
  });
  res.status(201).json({ task });
});

const SORT_SQL = {
  created_at: 't.created_at',
  due_date: 't.due_date',
  title: 'lower(t.title)',
  status: 't.status',
  priority: "CASE t.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
};

// Lists every task the caller can see (created, assigned, or in one of their teams), with filters.
router.get('/', validate(listSchema, 'query'), async (req, res) => {
  const f = req.validatedQuery;
  const params = [req.user.id];
  const where = [
    `(t.created_by = $1 OR t.assignee_id = $1 OR EXISTS
       (SELECT 1 FROM team_members m WHERE m.team_id = t.team_id AND m.user_id = $1))`,
  ];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.status) add('t.status = ?', f.status);
  if (f.priority) add('t.priority = ?', f.priority);
  if (f.team_id) add('t.team_id = ?', f.team_id);
  if (f.assignee === 'me') add('t.assignee_id = ?', req.user.id);
  else if (f.assignee === 'unassigned') where.push('t.assignee_id IS NULL');
  else if (f.assignee) add('t.assignee_id = ?', f.assignee);
  if (f.created_by) add('t.created_by = ?', f.created_by === 'me' ? req.user.id : f.created_by);
  if (f.due_before) add('t.due_date <= ?', f.due_before);
  if (f.due_after) add('t.due_date >= ?', f.due_after);
  if (f.q) {
    // Escape LIKE wildcards so user input is matched literally.
    params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`);
    const p = `$${params.length}`;
    where.push(`(t.title ILIKE ${p} ESCAPE '\\' OR t.description ILIKE ${p} ESCAPE '\\')`);
  }
  const dir = f.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (f.page - 1) * f.limit;
  params.push(f.limit, offset);
  const { rows } = await query(
    `SELECT t.*, count(*) OVER()::int AS total
       FROM tasks t
      WHERE ${where.join(' AND ')}
      ORDER BY ${SORT_SQL[f.sort]} ${dir} NULLS LAST, t.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = rows[0]?.total ?? 0;
  res.json({
    tasks: rows.map(({ total: _t, ...task }) => task),
    pagination: { page: f.page, limit: f.limit, total, pages: Math.ceil(total / f.limit) },
  });
});

router.get('/:id', async (req, res) => {
  const { is_team_owner: _o, ...task } = await getAccessibleTask(req.params.id, req.user.id);
  res.json({ task });
});

router.patch('/:id', validate(updateSchema), async (req, res) => {
  const task = await getAccessibleTask(req.params.id, req.user.id);
  const b = req.body;
  if ('assignee_id' in b) await assertAssignable(task, b.assignee_id);

  const sets = [];
  const params = [task.id];
  for (const col of ['title', 'description', 'due_date', 'priority', 'assignee_id']) {
    if (col in b) {
      params.push(b[col]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (b.status) {
    params.push(b.status);
    sets.push(`status = $${params.length}`);
    sets.push(b.status === 'completed' ? 'completed_at = COALESCE(completed_at, now())' : 'completed_at = NULL');
  }
  const { rows } = await query(
    `UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    params
  );
  const updated = rows[0];

  if ('assignee_id' in b && updated.assignee_id !== task.assignee_id) {
    await notify(updated.assignee_id, req.user.id, {
      type: 'task_assigned',
      taskId: updated.id,
      message: `You were assigned the task "${updated.title}"`,
    });
  } else {
    await notify(updated.assignee_id, req.user.id, {
      type: 'task_updated',
      taskId: updated.id,
      message: `The task "${updated.title}" was updated`,
    });
  }
  if (b.status === 'completed' && task.status !== 'completed') {
    await notify(updated.created_by, req.user.id, {
      type: 'task_completed',
      taskId: updated.id,
      message: `The task "${updated.title}" was marked completed`,
    });
  }
  res.json({ task: updated });
});

// Convenience for user story 6.
router.post('/:id/complete', async (req, res) => {
  const task = await getAccessibleTask(req.params.id, req.user.id);
  const { rows } = await query(
    `UPDATE tasks SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [task.id]
  );
  if (task.status !== 'completed') {
    await notify(task.created_by, req.user.id, {
      type: 'task_completed',
      taskId: task.id,
      message: `The task "${task.title}" was marked completed`,
    });
  }
  res.json({ task: rows[0] });
});

// Only the creator or a team owner may delete a task.
router.delete('/:id', async (req, res) => {
  const task = await getAccessibleTask(req.params.id, req.user.id);
  if (task.created_by !== req.user.id && !task.is_team_owner) {
    throw forbidden('Only the task creator or a team owner can delete this task');
  }
  await query('DELETE FROM tasks WHERE id = $1', [task.id]);
  res.status(204).end();
});

module.exports = router;
