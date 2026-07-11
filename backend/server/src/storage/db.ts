import knex from 'knex';
import config from './knexfile';
import { env } from '../config/env';

// Determine the Knex environment configuration
const environment = env.NODE_ENV === 'test' ? 'development' : env.NODE_ENV;
const knexConfig = config[environment];

if (!knexConfig) {
  throw new Error(`Knex configuration not found for environment: ${environment}`);
}

/**
 * Global Knex Database Client Instance.
 * Manages PostgreSQL connection pools and offers the Query Builder interface.
 */
export const db = knex(knexConfig);

// Helper to check DB connectivity
export async function checkDatabaseConnection(): Promise<void> {
  try {
    await db.raw('SELECT 1');
    console.log('✅ PostgreSQL database connection established successfully.');
  } catch (error) {
    console.error('❌ Failed to connect to the database:', error);
    throw error;
  }
}
