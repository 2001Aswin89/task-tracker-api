const router = require('express').Router();
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { addStream, removeStream } = require('../services/notifier');
const { notFound } = require('../errors');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  const { rows } = await query(
    `SELECT * FROM notifications
      WHERE user_id = $1 AND ($2::boolean = false OR read_at IS NULL)
      ORDER BY created_at DESC, id DESC LIMIT 100`,
    [req.user.id, unreadOnly]
  );
  res.json({ notifications: rows });
});

// Server-Sent Events: real-time push of new notifications.
// EventSource cannot set headers, so this route also accepts ?token=<jwt>.
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: ready\ndata: {}\n\n');
  addStream(req.user.id, res);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    removeStream(req.user.id, res);
  });
});

router.post('/read-all', async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.status(204).end();
});

router.patch('/:id/read', async (req, res) => {
  const { rows } = await query(
    'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING *',
    [req.params.id, req.user.id]
  );
  if (!rows.length) throw notFound('Notification');
  res.json({ notification: rows[0] });
});

module.exports = router;
