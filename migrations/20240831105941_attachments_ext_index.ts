import type { Knex } from 'knex';

export const up = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    create index attachments_extension_idx on attachments
      -- Negative positions (from the end) in 'split_part' are supported only in PostgreSQL 14+
      ( lower(reverse(split_part(reverse(file_name), '.', 1))) );
end$$`);

export const down = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    drop index attachments_extension_idx;
end$$`);
