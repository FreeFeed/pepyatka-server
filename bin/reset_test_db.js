/* eslint-disable no-await-in-loop */
import knexLib from 'knex';
import parseArgs from 'minimist';

import { getDbSchemaName } from '../app/support/parallel-testing';

const args = parseArgs(process.argv.slice(2));
let nSchemas = Number.parseInt(args['schemas']);

if (!Number.isFinite(nSchemas) || nSchemas < 1) {
  nSchemas = 1;
}

// Forcefully set the NODE_ENV to 'test'
process.env.NODE_ENV = 'test';

const config = require('../knexfile');

if (!('test' in config)) {
  process.stderr.write(`Error: no "test" section in knexfile`);
  process.exit(1);
}

const knex = knexLib(config.test);

async function resetSchema(schemaName) {
  console.log(`Resetting the ${schemaName} schema`);
  await knex.raw(`drop schema if exists :schemaName: cascade`, { schemaName });
  await knex.raw(`create schema :schemaName:`, { schemaName });
}

async function run() {
  // Public schema
  await resetSchema('public');
  console.log(`Running migrations`);
  await knex.migrate.latest();
  console.log(`Migration completed`);

  // Other schemas
  for (let i = 1; i < nSchemas; i++) {
    // Emulating MOCHA_WORKER_ID for proper schema name generation
    process.env.MOCHA_WORKER_ID = i.toString(10);
    const schemaName = getDbSchemaName();
    await resetSchema(schemaName);
    console.log(`Running migrations on ${schemaName} schema`);
    await knex.migrate.latest({ schemaName });
    console.log(`Migration completed on ${schemaName} schema`);
  }
}

run()
  .then(() => {
    knex.destroy();
    console.log(`All done.`);
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`Error: ${e}\n`);
    knex.destroy();
    process.exit(1);
  });
