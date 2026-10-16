require('dotenv').config({ quiet: true });

const isTest = process.env.NODE_ENV === 'test';

/** Point the connection string at a different database name (used to isolate tests). */
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const baseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/tasktracker';

module.exports = {
  isTest,
  port: Number(process.env.PORT || 3000),
  databaseUrl: isTest ? withDatabase(baseUrl, 'tasktracker_test') : baseUrl,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '2h',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024),
  llm: {
    provider: isTest ? 'mock' : process.env.LLM_PROVIDER || 'mock',
    geminiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  },
};
