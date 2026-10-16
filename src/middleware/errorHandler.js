const multer = require('multer');
const { HttpError } = require('../errors');

function notFoundHandler(req, _res, next) {
  next(new HttpError(404, 'not_found', `Route ${req.method} ${req.path} not found`));
}

/** Single error shape for the whole API: { code, message, details? }. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ code: 'upload_error', message: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 'bad_request', message: 'Malformed JSON body' });
  }
  if (err instanceof HttpError) {
    const body = { code: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  // Postgres: invalid id format etc. should not leak as 500s.
  if (err.code === '22P02' || err.code === '22003') {
    return res.status(400).json({ code: 'bad_request', message: 'Invalid identifier or value' });
  }
  console.error(err);
  res.status(500).json({ code: 'internal_error', message: 'Something went wrong' });
}

module.exports = { notFoundHandler, errorHandler };
