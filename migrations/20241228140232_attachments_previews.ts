import type { Knex } from 'knex';

export const up = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    alter table attachments add column previews jsonb;
    alter table attachments add column meta jsonb;
    alter table attachments add column width integer;
    alter table attachments add column height integer;
    alter table attachments add column duration float;

    create index idx_attachments_meta on attachments using gin (meta jsonb_path_ops);
end$$`);

export const down = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    alter table attachments drop column previews;
    alter table attachments drop column meta;
    alter table attachments drop column width;
    alter table attachments drop column height;
    alter table attachments drop column duration;
end$$`);
