const { HttpError } = require('../errors');

/**
 * Validate req[source] against a zod schema and replace it with the parsed value.
 * Express 5 makes req.query read-only, so parsed query values go to req.validatedQuery.
 */
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      return next(new HttpError(422, 'validation_error', 'Request validation failed', details));
    }
    if (source === 'query') req.validatedQuery = result.data;
    else req[source] = result.data;
    next();
  };
}

module.exports = { validate };
