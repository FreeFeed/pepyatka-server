import type { Knex } from 'knex';

export const up = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    -- Tables

    -- Post counters
    create table post_counters (
      post_id uuid not null primary key
        references posts (uid) on delete cascade on update cascade,
      comments_count integer not null default 0,
      likes_count integer not null default 0
    );

    create index post_counters_comments_count_idx
      on post_counters using btree (comments_count);
    create index post_counters_likes_count_idx
      on post_counters using btree (likes_count);

    -- Triggers

    -- Creates record in post_counters on post creation
    create or replace function trg_create_post_counters() returns trigger as
    $BODY$
    begin
      insert into post_counters (post_id) values (new.uid);
      return new;
    end;
    $BODY$
    language plpgsql volatile cost 100;

    -- Updates comments_count on comment creation and deletion
    create or replace function trg_update_post_comments_count() returns trigger as
    $BODY$
    begin
      if (TG_OP = 'INSERT') then
        update post_counters
        set comments_count = comments_count + 1
        where post_id = new.post_id;
      elsif (TG_OP = 'DELETE') then
        update post_counters
        set comments_count = comments_count - 1
        where post_id = old.post_id;
      end if;
      return new;
    end;
    $BODY$
    language plpgsql volatile cost 100;

    -- Updates likes_count on like creation and deletion
    create or replace function trg_update_post_likes_count() returns trigger as
    $BODY$
    begin
      if (TG_OP = 'INSERT') then
        update post_counters
        set likes_count = likes_count + 1
        where post_id = new.post_id;
      elsif (TG_OP = 'DELETE') then
        update post_counters
        set likes_count = likes_count - 1
        where post_id = old.post_id;
      end if;
      return new;
    end;
    $BODY$
    language plpgsql volatile cost 100;

    -- Bind triggers
    create trigger trg_create_post_counters
      after insert on posts
      for each row execute procedure trg_create_post_counters();
    create trigger trg_update_post_comments_count
      after insert or delete on comments
      for each row execute procedure trg_update_post_comments_count();
    create trigger trg_update_post_likes_count
      after insert or delete on likes
      for each row execute procedure trg_update_post_likes_count();

end$$`);

export const down = (knex: Knex) =>
  knex.schema.raw(`do $$begin
    drop table post_counters;

    -- Unbind triggers
    drop trigger trg_create_post_counters on posts;
    drop trigger trg_update_post_comments_count on comments;
    drop trigger trg_update_post_likes_count on likes;

    -- Drop triggers
    drop function trg_create_post_counters();
    drop function trg_update_post_comments_count();
    drop function trg_update_post_likes_count();
end$$`);
