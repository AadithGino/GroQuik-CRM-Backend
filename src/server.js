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

  // BullMQ/Upstash script failures must never take down the HTTP API.
  process.on('uncaughtException', (err) => {
    const message = err?.message || String(err);
    if (message.includes('The "data" argument must be of type string or an instance of Buffer') || err?.code === 'ERR_INVALID_ARG_TYPE') {
      console.error('Suppressed BullMQ/Redis uncaught exception; API stays up:', message);
      return;
    }
    console.error('Uncaught exception', err);
    process.exit(1);
  });

  try {
    startWorkers();
  } catch (err) {
    console.error('Worker startup failed (API continues):', err?.message || err);
  }

  server.listen(env.PORT, () => {
    console.log(`CRM backend running on port ${env.PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
