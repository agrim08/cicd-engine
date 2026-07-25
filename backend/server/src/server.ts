import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as path from 'path';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

// Import environment configuration first to trigger Zod validation early
import { env } from './config/env';
import { db, checkDatabaseConnection } from './storage/db';
import { errorHandler, AppError } from './middleware/errors';

// Import Routers
import { webhookRouter } from './routes/webhook';
import { reposRouter } from './routes/repos';
import { secretsRouter } from './routes/secrets';

// Import Queue and BullBoard
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { jobQueue } from './queue/manager';
import './queue/processor'; // Load worker listeners

const app = express();

// 1. Raw body parsing for GitHub Webhook signature validation (must run before standard body parsers)
app.use('/webhook', express.raw({ type: 'application/json' }));

// 2. Swagger Configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'GitHub Actions Clone API',
      version: '1.0.0',
      description: 'API documentation for GitHub Actions Clone',
    },
  },
  apis: [path.join(__dirname, '**/*.{ts,js}').replace(/\\/g, '/')],
}

const swaggerDocs = swaggerJSDoc(swaggerOptions)

// 3. Standard middleware for security and request parsing (JSON/Urlencoded)
app.use(
  helmet({
    contentSecurityPolicy: false, // Disabled to allow BullBoard styles/assets to render in dashboard
  })
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 4. Setup BullBoard
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullMQAdapter(jobQueue)],
  serverAdapter: serverAdapter,
});

// 5. Mount API Routes
app.use('/admin/queues', serverAdapter.getRouter());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));
app.use('/webhook', webhookRouter);
app.use('/api/v1/repos', reposRouter);
app.use('/api/v1/repos/:repoId/secrets', secretsRouter);

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Check system health status
 *     description: Returns the status of the server and database connectivity.
 *     responses:
 *       200:
 *         description: Server is healthy and database is connected.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 *                   example: 2026-07-12T15:03:10.000Z
 *                 services:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: string
 *                       example: connected
 *                     server:
 *                       type: string
 *                       example: healthy
 *       500:
 *         description: Server database connection or other system services are unhealthy.
 */
app.get('/health', async (req, res, next) => {
  try {
    // Perform database health check query
    await db.raw('SELECT 1');
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        server: 'healthy',
      },
    });
  } catch (error) {
    // If DB check fails, pass database down status to error middleware
    next(new AppError('Database connection unhealthy', 500, true));
  }
});

// Fallback for non-matching routes
app.use((req, res, next) => {
  next(new AppError(`Route ${req.originalUrl} not found`, 404, true));
});

// Register Global Error Handling Middleware
app.use(errorHandler);

/**
 * Boots the Express Server.
 * Verifies DB connectivity and executes pending migrations before binding the port.
 */
async function bootstrap() {
  try {
    console.log('🚀 Starting GitHub Actions Clone API Server bootstrap sequence...');

    // 1. Verify PostgreSQL Database Connection
    await checkDatabaseConnection();

    // 2. Run Database Migrations to keep DB schema up-to-date
    console.log('🔄 Running database migrations...');
    const migrationConfig = {
      directory: path.join(__dirname, 'storage/migrations'),
    };
    const [batchNo, log] = await db.migrate.latest(migrationConfig);
    if (log.length === 0) {
      console.log('✅ Database schema is already up-to-date. No migrations ran.');
    } else {
      console.log(`✅ Database migrated successfully in batch ${batchNo}. Executed migrations:\n`, log.join('\n'));
    }

    // 3. Bind the server to the port
    app.listen(env.PORT, () => {
      console.log(`📡 Server running in [${env.NODE_ENV}] mode on port ${env.PORT}`);
    });
  } catch (error) {
    console.error('❌ Bootstrap sequence failed:', error);
    process.exit(1);
  }
}

// Start the server
bootstrap();
