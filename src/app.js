import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middlewares/error.middleware.js';
import authRoutes from './routes/auth.routes.js';
import leadRoutes from './routes/lead.routes.js';
import taskRoutes from './routes/task.routes.js';
import meetingRoutes from './routes/meeting.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import userRoutes from './routes/user.routes.js';
import activityRoutes from './routes/activity.routes.js';
import assignmentRoutes from './routes/assignment.routes.js';
import metaRoutes from './routes/meta.routes.js';
import quoteRoutes from './routes/quote.routes.js';
import mockupRoutes from './routes/mockup.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import projectRoutes from './routes/project.routes.js';
import reportRoutes from './routes/report.routes.js';
import importRoutes from './routes/import.routes.js';
import whatsappRoutes from './routes/whatsapp.routes.js';
import fileRoutes from './routes/file.routes.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(compression());
  app.use(cors({ origin: env.CLIENT_URL, credentials: true }));
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      if (req.originalUrl === '/api/meta/webhook') {
        req.rawBody = buf;
      }
    },
  }));
  app.use(cookieParser());
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 2000 }));

  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/leads', leadRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/meetings', meetingRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/activities', activityRoutes);
  app.use('/api/assignments', assignmentRoutes);
  app.use('/api/meta', metaRoutes);
  app.use('/api/quotes', quoteRoutes);
  app.use('/api/mockups', mockupRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/imports', importRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR)));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
