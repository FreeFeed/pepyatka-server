import type { Knex } from 'knex';

export const up = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    alter table attachments add column previews jsonb;
end$$`);

export const down = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    alter table attachments drop column previews;
end$$`);
