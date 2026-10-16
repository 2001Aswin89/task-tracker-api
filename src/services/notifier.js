const { query } = require('../db/pool');

// userId -> Set of open SSE responses (a user may have several tabs open).
const streams = new Map();

function addStream(userId, res) {
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
}

function removeStream(userId, res) {
  const set = streams.get(userId);
  if (!set) return;
  set.delete(res);
  if (!set.size) streams.delete(userId);
}

/**
 * Persist a notification and push it to any live SSE connections.
 * Never notifies the actor about their own action.
 */
async function notify(userId, actorId, { type, taskId, message }) {
  if (!userId || userId === actorId) return;
  const { rows } = await query(
    `INSERT INTO notifications (user_id, type, task_id, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, type, taskId, message]
  );
  const payload = `event: notification\ndata: ${JSON.stringify(rows[0])}\n\n`;
  for (const res of streams.get(userId) || []) res.write(payload);
}

module.exports = { addStream, removeStream, notify };
