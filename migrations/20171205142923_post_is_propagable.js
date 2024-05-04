export async function up(knex) {
  await knex.schema
    .table('posts', (table) => {
      table
        .boolean('is_propagable')
        .defaultTo(false)
        .notNullable()
        .comment('Marks a posts as propagable by likes/comments');
    })
    // Trigger function to update 'is_propagable' flag
    .raw(
      `
     CREATE OR REPLACE FUNCTION trgfun_set_post_is_propagable_on_insert_update()
       RETURNS trigger AS
     $BODY$
     -- Set 'is_propagable' post flag on insert or update.
     -- Post is 'is_propagable' only if it posted to 'Posts' feed of some user (not group).
     begin
       NEW.is_propagable := exists(
         select 1 from
           feeds f
           join users u on u.uid = f.user_id
         where
           array[f.id] && NEW.destination_feed_ids
           and f.name = 'Posts'
           and u.type = 'user'
       );
       return NEW;
     end;
     $BODY$
       LANGUAGE plpgsql VOLATILE
       COST 100;
   `,
    )
    // Bind trigger
    .raw(
      `CREATE TRIGGER trg_set_post_is_propagable_on_insert_update
    BEFORE INSERT OR UPDATE OF destination_feed_ids
    ON posts
    FOR EACH ROW
    EXECUTE PROCEDURE trgfun_set_post_is_propagable_on_insert_update();`,
    )
    // Data migration
    .raw(
      `
     update posts p set
       is_propagable = exists(
         select 1 from
           feeds f
           join users u on u.uid = f.user_id
         where
           array[f.id] && p.destination_feed_ids
           and f.name = 'Posts'
           and u.type = 'user'
       )
   `,
    )
    .table('posts', (table) => {
      table.index('is_propagable', 'posts_is_propagable_idx');
    });
}

export async function down(knex) {
  await knex.schema
    .raw('DROP TRIGGER trg_set_post_is_propagable_on_insert_update ON posts')
    .raw('DROP FUNCTION trgfun_set_post_is_propagable_on_insert_update()')
    .table('posts', (table) => {
      table.dropIndex('', 'posts_is_propagable_idx');
      table.dropColumn('is_propagable');
    });
}
