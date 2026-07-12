import { z } from 'zod';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from root directory to support running from workspaces
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

/**
 * Zod Schema for environment variable validation.
 * Ensures the app fails fast at startup if configuration is invalid.
 */
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid PostgreSQL connection URL' }),
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid Redis connection URL' }),

  GITHUB_WEBHOOK_SECRET: z.string().min(1, { message: 'GITHUB_WEBHOOK_SECRET is required' }),
  GITHUB_TOKEN: z.string().min(1, { message: 'GITHUB_TOKEN is required' }),

  // Encryption key must be exactly 32 bytes (64 hex characters)
  ENCRYPTION_KEY: z.string().length(64, { message: 'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)' }),
  RUNNER_JWT_SECRET: z.string().min(8, { message: 'RUNNER_JWT_SECRET must be at least 8 characters long' }),

  R2_ACCOUNT_ID: z.string().min(1, { message: 'R2_ACCOUNT_ID is required' }),
  R2_ACCESS_KEY_ID: z.string().min(1, { message: 'R2_ACCESS_KEY_ID is required' }),
  R2_SECRET_ACCESS_KEY: z.string().min(1, { message: 'R2_SECRET_ACCESS_KEY is required' }),
  R2_BUCKET_NAME: z.string().min(1, { message: 'R2_BUCKET_NAME is required' }),
});

// Infer configuration type from validation schema
export type EnvConfig = z.infer<typeof envSchema>;

let env: EnvConfig;

try {
  // Parse environment variables using process.env
  env = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    const missingOrInvalid = error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join('\n');
    console.error('❌ Invalid environment configuration:\n' + missingOrInvalid);
    process.exit(1);
  }
  throw error;
}

export { env };
