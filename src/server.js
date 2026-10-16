const config = require('./config');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');

async function main() {
  await migrate();
  createApp().listen(config.port, () => console.log(`Task tracker API listening on http://localhost:${config.port}`));
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
