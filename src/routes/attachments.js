const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const router = require('express').Router();
const config = require('../config');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getAccessibleTask } = require('../services/access');
const { notify } = require('../services/notifier');
const { HttpError, badRequest, notFound, forbidden } = require('../errors');

router.use(requireAuth);

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

fs.mkdirSync(config.uploadDir, { recursive: true });

// Files are stored under random names; the original name is kept only in the database.
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) =>
    ALLOWED_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new HttpError(415, 'unsupported_media_type', `File type ${file.mimetype} is not allowed`)),
});

const taskAttachments = require('express').Router({ mergeParams: true });
taskAttachments.use(requireAuth);

taskAttachments.post('/', async (req, res, next) => {
  try {
    // Check access before accepting any bytes.
    req.task = await getAccessibleTask(req.params.taskId, req.user.id);
  } catch (err) {
    return next(err);
  }
  upload.single('file')(req, res, async (err) => {
    try {
      if (err) throw err;
      if (!req.file) throw badRequest('Send the file as multipart/form-data in the "file" field');
      const { rows } = await query(
        `INSERT INTO attachments (task_id, user_id, original_name, stored_name, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, task_id, user_id, original_name, mime_type, size_bytes, created_at`,
        [req.task.id, req.user.id, path.basename(req.file.originalname), req.file.filename, req.file.mimetype, req.file.size]
      );
      const message = `New attachment on "${req.task.title}"`;
      await notify(req.task.assignee_id, req.user.id, { type: 'task_attachment', taskId: req.task.id, message });
      res.status(201).json({ attachment: rows[0] });
    } catch (e) {
      if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
      next(e);
    }
  });
});

taskAttachments.get('/', async (req, res) => {
  const task = await getAccessibleTask(req.params.taskId, req.user.id);
  const { rows } = await query(
    `SELECT id, task_id, user_id, original_name, mime_type, size_bytes, created_at
       FROM attachments WHERE task_id = $1 ORDER BY created_at`,
    [task.id]
  );
  res.json({ attachments: rows });
});

async function loadAttachment(id) {
  const { rows } = await query('SELECT * FROM attachments WHERE id = $1', [id]);
  if (!rows.length) throw notFound('Attachment');
  return rows[0];
}

router.get('/:id/download', async (req, res) => {
  const att = await loadAttachment(req.params.id);
  await getAccessibleTask(att.task_id, req.user.id);
  res.download(path.resolve(config.uploadDir, att.stored_name), att.original_name);
});

router.delete('/:id', async (req, res) => {
  const att = await loadAttachment(req.params.id);
  const task = await getAccessibleTask(att.task_id, req.user.id);
  if (att.user_id !== req.user.id && task.created_by !== req.user.id && !task.is_team_owner) {
    throw forbidden('Only the uploader, task creator or a team owner can delete this attachment');
  }
  await query('DELETE FROM attachments WHERE id = $1', [att.id]);
  fs.promises.unlink(path.resolve(config.uploadDir, att.stored_name)).catch(() => {});
  res.status(204).end();
});

module.exports = { attachmentsRouter: router, taskAttachments };
