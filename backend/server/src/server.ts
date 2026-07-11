import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as path from 'path';

// Import environment configuration first to trigger Zod validation early
import { env } from './config/env';
import { db, checkDatabaseConnection } from './storage/db';
import { errorHandler, AppError } from './middleware/errors';

const app = express();

// Standard middleware for security and request parsing
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * @route GET /health
 * @desc Checks connectivity to database and general server health
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
