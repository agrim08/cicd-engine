import type { Knex } from 'knex';

/**
 * Migration: Create foundational schema tables for GitHub Actions Clone.
 * Order of creation is strictly controlled to satisfy relational foreign key constraints.
 */
export async function up(knex: Knex): Promise<void> {
  // Enable pgcrypto for gen_random_uuid() support in PostgreSQL
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // 1. repos table
  await knex.schema.createTable('repos', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('github_repo_url').notNullable().unique();
    table.string('webhook_secret').notNullable();
    table.string('github_token').nullable();
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // 2. workflows table
  await knex.schema.createTable('workflows', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('repo_id').references('id').inTable('repos').onDelete('CASCADE').notNullable();
    table.string('name').notNullable();
    table.string('yaml_path').defaultTo('.cicd/pipeline.yaml').notNullable();
    table.text('yaml_content').nullable();
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    
    // Constraint to prevent duplicate workflow names in the same repo
    table.unique(['repo_id', 'name']);
  });

  // 3. runs table
  await knex.schema.createTable('runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('workflow_id').references('id').inTable('workflows').onDelete('CASCADE').notNullable();
    table.string('sha').notNullable();
    table.string('branch').notNullable();
    table.string('trigger').notNullable(); // push | pull_request | manual
    table.string('status').defaultTo('pending').notNullable(); // pending | running | success | failed | cancelled
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('completed_at', { useTz: true }).nullable();

    // Prevent duplicate run entries for the exact same commit in a workflow
    table.unique(['workflow_id', 'sha']);
  });

  // 4. runners table
  await knex.schema.createTable('runners', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable().unique();
    table.jsonb('labels').defaultTo('[]').notNullable(); // e.g. ["ubuntu", "docker"]
    table.string('auth_token_hash').notNullable();
    table.timestamp('last_heartbeat', { useTz: true }).nullable();
    table.string('status').defaultTo('idle').notNullable(); // idle | busy | offline
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // 5. jobs table
  await knex.schema.createTable('jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('run_id').references('id').inTable('runs').onDelete('CASCADE').notNullable();
    table.string('name').notNullable();
    table.string('status').defaultTo('queued').notNullable(); // queued | running | success | failed | timeout | cancelled
    table.integer('exit_code').nullable();
    table.uuid('runner_id').references('id').inTable('runners').onDelete('SET NULL').nullable();
    table.jsonb('matrix_value').nullable(); // e.g. {"node-version": "18"}
    table.timestamp('started_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
  });

  // 6. steps table
  await knex.schema.createTable('steps', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('job_id').references('id').inTable('jobs').onDelete('CASCADE').notNullable();
    table.string('name').notNullable();
    table.string('status').defaultTo('pending').notNullable(); // pending | running | success | failed
    table.integer('exit_code').nullable();
    table.integer('duration_ms').nullable();
    table.integer('step_order').notNullable();
  });

  // 7. logs table
  await knex.schema.createTable('logs', (table) => {
    table.bigIncrements('id').primary();
    table.uuid('job_id').references('id').inTable('jobs').onDelete('CASCADE').notNullable();
    table.uuid('step_id').references('id').inTable('steps').onDelete('CASCADE').nullable();
    table.integer('line_no').notNullable();
    table.text('content').notNullable();
    table.timestamp('timestamp', { useTz: true }).defaultTo(knex.fn.now());

    // Indexes for fast logs lookup during dashboard streaming and history retrieval
    table.index(['job_id']);
  });

  // 8. artifacts table
  await knex.schema.createTable('artifacts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('run_id').references('id').inTable('runs').onDelete('CASCADE').notNullable();
    table.uuid('job_id').references('id').inTable('jobs').onDelete('CASCADE').notNullable();
    table.string('name').notNullable();
    table.string('r2_key').notNullable();
    table.bigInteger('size_bytes').nullable();
    table.string('content_type').nullable();
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  // 9. secrets table
  await knex.schema.createTable('secrets', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('repo_id').references('id').inTable('repos').onDelete('CASCADE').notNullable();
    table.string('name').notNullable();
    table.text('encrypted_value').notNullable();
    table.string('iv').notNullable();
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    // Secrets must be unique per repository
    table.unique(['repo_id', 'name']);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Drop tables in exact reverse order to respect foreign keys
  await knex.schema.dropTableIfExists('secrets');
  await knex.schema.dropTableIfExists('artifacts');
  await knex.schema.dropTableIfExists('logs');
  await knex.schema.dropTableIfExists('steps');
  await knex.schema.dropTableIfExists('jobs');
  await knex.schema.dropTableIfExists('runners');
  await knex.schema.dropTableIfExists('runs');
  await knex.schema.dropTableIfExists('workflows');
  await knex.schema.dropTableIfExists('repos');
  
  // Disable pgcrypto extension
  await knex.raw('DROP EXTENSION IF EXISTS "pgcrypto"');
}
