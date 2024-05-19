import pgFormat from 'pg-format';
import { type Knex } from 'knex';

import { getDbSchemaName } from '../app/support/parallel-testing';

const tablesToKeep = ['admin_roles', 'event_types'];

export default async function cleanDB(knex: Knex) {
  const schemaName = getDbSchemaName();
  await knex.raw(
    `
    do $$
      declare
        row record;
      begin
        -- Temp. turn off all triggers
        set session_replication_role = replica;
        for row in 
          select tablename from pg_tables
            where schemaname = '${schemaName}' 
              and tablename not in (${pgFormat(`%L`, tablesToKeep)})
        loop
          execute format('delete from %I', row.tablename);
        end loop;
        set session_replication_role = default;
        end
    $$;
  `,
  );
}
