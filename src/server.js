import http from 'http';
import { createApp } from './app.js';
import { connectDb } from './config/db.js';
import { env } from './config/env.js';
import { initSocket } from './sockets/socket.js';
import { startWorkers } from './jobs/workers.js';
import { runStartupChecks } from './config/startupChecks.js';

async function bootstrap() {
  await connectDb();
  await runStartupChecks();
  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);
  startWorkers();

  server.listen(env.PORT, () => {
    console.log(`CRM backend running on port ${env.PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
