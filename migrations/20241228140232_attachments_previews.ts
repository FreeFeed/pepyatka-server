import type { Knex } from 'knex';

export const up = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    alter table attachments add column previews jsonb;
    alter table attachments add column meta jsonb;
end$$`);

export const down = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    alter table attachments drop column previews;
    alter table attachments drop column meta;
end$$`);
