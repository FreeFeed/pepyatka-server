export function up(knex) {
  return (
    knex.schema
      .table('posts', (table) => {
        table.boolean('is_private').defaultTo(false).notNullable();
        table.boolean('is_protected').defaultTo(false).notNullable();
      })
      .raw(
        `CREATE INDEX feeds_id_array_idx
      ON feeds
      USING gin
      ((ARRAY[id]) gin__int_ops);
    `,
      )
      // Trigger function for individual posts
      .raw(
        `
      CREATE OR REPLACE FUNCTION trgfun_set_post_privacy_on_insert_update()
        RETURNS trigger AS
      $BODY$
      -- Set proper is_private and is_protected flags on post insert or update
      declare
        rec record;
      begin
        select
          coalesce(bool_and(f.name = 'Directs' or u.is_private), true) as is_private,
          coalesce(bool_and(f.name = 'Directs' or u.is_protected), true) as is_protected
        into
          rec
        from
          feeds f
          join users u on f.user_id = u.uid
        where
          array[f.id] && NEW.destination_feed_ids;

        NEW.is_private := rec.is_private;
        NEW.is_protected := rec.is_protected or rec.is_private; -- for sure

        return NEW;
      end;
      $BODY$
        LANGUAGE plpgsql VOLATILE
        COST 100;
    `,
      )
      // Trigger function for users/groups
      .raw(
        `
      CREATE OR REPLACE FUNCTION trgfun_set_posts_privacy_on_user_update()
        RETURNS trigger AS
      $BODY$
      -- Set proper is_private and is_protected flags on all user's posts when the user changes his privacy
      declare
        feedId integer;
        privacyUpdateLock constant integer := 73543; -- unique magick code for this trigger
      begin
        select id into feedId from feeds where user_id = NEW.uid and name = 'Posts';
        if feedId is null then
          return null;
        end if;

        perform pg_advisory_xact_lock(privacyUpdateLock, feedId);

        if not NEW.is_protected then
          -- the simplest case, all posts becomes public
          update posts set 
            is_protected = false,
            is_private = false
          where destination_feed_ids && array[feedId];
        else
          -- posts posted into this feed only
          update posts set
            is_protected = NEW.is_protected,
            is_private = NEW.is_private 
          where destination_feed_ids = array[feedId];

          -- and posted not only into this feeds
          with prv as (
            select
              p.id, p.destination_feed_ids, 
              bool_and(f.name = 'Directs' or u.is_private) as is_private,
              bool_and(f.name = 'Directs' or u.is_protected) as is_protected
            from
              posts p
              join feeds f on array[f.id] && p.destination_feed_ids
              join users u on f.user_id = u.uid
            where
              array[feedId] && p.destination_feed_ids and 
              array[feedId] <> p.destination_feed_ids 
            group by p.id
          )
          update posts as p set 
            is_private = prv.is_private,
            is_protected = prv.is_protected or prv.is_private
          from prv where p.id = prv.id;

        end if;

        return null;
      end;
      $BODY$
        LANGUAGE plpgsql VOLATILE
        COST 100;
      `,
      )
      // Bind triggers
      .raw(
        `CREATE TRIGGER trg_set_post_privacy_on_insert_update
      BEFORE INSERT OR UPDATE OF destination_feed_ids
      ON posts
      FOR EACH ROW
      EXECUTE PROCEDURE trgfun_set_post_privacy_on_insert_update();`,
      )
      .raw(
        `CREATE TRIGGER trg_set_posts_privacy_on_user_update
      AFTER UPDATE OF is_private, is_protected
      ON users
      FOR EACH ROW
      WHEN (((old.is_protected <> new.is_protected) OR (old.is_private <> new.is_private)))
      EXECUTE PROCEDURE trgfun_set_posts_privacy_on_user_update();`,
      )
      // Data migration
      .raw('update posts set destination_feed_ids = destination_feed_ids')
      // Indexes and constraints
      .raw(
        'alter table posts add constraint posts_is_protected_check check (is_protected or not is_private)',
      )
      .table('posts', (table) => {
        table.index('is_private', 'posts_is_private_idx', 'btree');
        table.index('is_protected', 'posts_is_protected_idx', 'btree');
      })
  );
}

export function down(knex) {
  return knex.schema
    .table('posts', (table) => {
      table.dropIndex('', 'posts_is_private_idx');
      table.dropIndex('', 'posts_is_protected_idx');
    })
    .raw('alter table posts drop constraint posts_is_protected_check')
    .raw('DROP TRIGGER trg_set_posts_privacy_on_user_update ON users')
    .raw('DROP TRIGGER trg_set_post_privacy_on_insert_update ON posts')
    .raw('DROP FUNCTION trgfun_set_post_privacy_on_insert_update()')
    .raw('DROP FUNCTION trgfun_set_posts_privacy_on_user_update()')
    .table('feeds', (table) => table.dropIndex('', 'feeds_id_array_idx'))
    .table('posts', (table) => {
      table.dropColumn('is_private');
      table.dropColumn('is_protected');
    });
}
