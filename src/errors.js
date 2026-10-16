/** Application error carrying an HTTP status and a stable machine-readable code. */
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, 'bad_request', msg, details);
const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'unauthorized', msg);
const forbidden = (msg = 'You do not have access to this resource') => new HttpError(403, 'forbidden', msg);
const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
const conflict = (msg) => new HttpError(409, 'conflict', msg);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
