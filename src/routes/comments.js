const router = require('express').Router();
const { z } = require('zod');
const { query } = require('../db/pool');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { getAccessibleTask } = require('../services/access');
const { notify } = require('../services/notifier');
const { notFound, forbidden } = require('../errors');

router.use(requireAuth);

const bodySchema = z.object({ body: z.string().trim().min(1).max(2000) });

// Mounted at /tasks/:taskId/comments
const taskComments = require('express').Router({ mergeParams: true });
taskComments.use(requireAuth);

taskComments.post('/', validate(bodySchema), async (req, res) => {
  const task = await getAccessibleTask(req.params.taskId, req.user.id);
  const { rows } = await query(
    `INSERT INTO comments (task_id, user_id, body) VALUES ($1, $2, $3)
     RETURNING id, task_id, user_id, body, created_at`,
    [task.id, req.user.id, req.body.body]
  );
  const message = `New comment on "${task.title}"`;
  await notify(task.assignee_id, req.user.id, { type: 'task_commented', taskId: task.id, message });
  if (task.created_by !== task.assignee_id) {
    await notify(task.created_by, req.user.id, { type: 'task_commented', taskId: task.id, message });
  }
  res.status(201).json({ comment: rows[0] });
});

taskComments.get('/', async (req, res) => {
  const task = await getAccessibleTask(req.params.taskId, req.user.id);
  const { rows } = await query(
    `SELECT c.id, c.task_id, c.user_id, u.name AS author_name, c.body, c.created_at
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.task_id = $1 ORDER BY c.created_at, c.id`,
    [task.id]
  );
  res.json({ comments: rows });
});

// Authors may delete their own comments (mounted at /comments).
router.delete('/:id', async (req, res) => {
  const { rows } = await query('SELECT id, task_id, user_id FROM comments WHERE id = $1', [req.params.id]);
  if (!rows.length) throw notFound('Comment');
  await getAccessibleTask(rows[0].task_id, req.user.id);
  if (rows[0].user_id !== req.user.id) throw forbidden('You can only delete your own comments');
  await query('DELETE FROM comments WHERE id = $1', [rows[0].id]);
  res.status(204).end();
});

module.exports = { commentsRouter: router, taskComments };
