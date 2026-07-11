import type { Knex } from 'knex';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables for Knex CLI usages
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const config: { [key: string]: Knex.Config } = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL || 'postgresql://cicd:cicd@localhost:5432/cicd',
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      tableName: 'knex_migrations',
      directory: path.join(__dirname, 'migrations'),
      extension: 'ts',
    },
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      tableName: 'knex_migrations',
      directory: path.join(__dirname, 'migrations'),
      extension: 'js',
    },
  },
};

export default config;
