const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { query } = require('./db/pool');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const { taskComments } = require('./routes/comments');
const { taskAttachments } = require('./routes/attachments');

function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/teams', require('./routes/teams'));
  app.use('/api/tasks/:taskId/comments', taskComments);
  app.use('/api/tasks/:taskId/attachments', taskAttachments);
  app.use('/api/tasks', require('./routes/tasks'));
  app.use('/api/comments', require('./routes/comments').commentsRouter);
  app.use('/api/attachments', require('./routes/attachments').attachmentsRouter);
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/ai', require('./routes/ai'));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
