/* eslint babel/semi: "error" */
import knexjs from 'knex';
import createDebug from 'debug';
import config from 'config';
import { uniq } from 'lodash';

import { stylize } from '../support/debugLogger';
import { getDbSchemaName } from '../support/parallel-testing';

/** @type {import("knex").Knex.Config} */
const pgConfig = { ...config.postgres };

const schemaName = getDbSchemaName();

if (schemaName !== 'public') {
  pgConfig.searchPath = uniq([schemaName, 'public', ...(pgConfig.searchPath || [])]);
}

const log = createDebug('freefeed:sql');
const errLog = createDebug('freefeed:sql:error');

let knex = null;
export function connect() {
  if (knex) {
    return knex;
  }

  knex = knexjs(pgConfig);
  knex.on('start', (builder) => {
    const q = builder.toString();
    const start = new Date().getTime();

    builder.on('end', () => {
      log('%s %s', q, stylize(`[took ${new Date().getTime() - start}ms]`, 'green'));
    });

    builder.on('error', () => {
      errLog('%s %s', stylize('ERROR', 'red'), q);
    });
  });

  return knex;
}

export async function setSearchConfig() {
  const { textSearchConfigName } = pgConfig;
  await knex.raw(`SET default_text_search_config TO '${textSearchConfigName}'`);
}
