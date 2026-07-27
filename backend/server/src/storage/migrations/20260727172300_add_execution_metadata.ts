import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // 1. Add image and env columns to jobs table
  await knex.schema.alterTable('jobs', (table) => {
    table.string('image').defaultTo('ubuntu-latest').notNullable();
    table.jsonb('env').defaultTo('{}').notNullable();
  });

  // 2. Add run, env, and condition columns to steps table
  await knex.schema.alterTable('steps', (table) => {
    table.text('run').defaultTo('').notNullable();
    table.jsonb('env').defaultTo('{}').notNullable();
    table.string('condition').nullable(); // condition is nullable since 'if' block is optional
  });
}

export async function down(knex: Knex): Promise<void> {
  // 1. Remove columns from steps table
  await knex.schema.alterTable('steps', (table) => {
    table.dropColumn('condition');
    table.dropColumn('env');
    table.dropColumn('run');
  });

  // 2. Remove columns from jobs table
  await knex.schema.alterTable('jobs', (table) => {
    table.dropColumn('env');
    table.dropColumn('image');
  });
}

