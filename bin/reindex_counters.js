/* eslint-disable no-await-in-loop */
import { promises as fs } from 'fs';
import path from 'path';
import { setTimeout } from 'timers/promises';

import { program } from 'commander';

import { dbAdapter } from '../app/models';

// Recalculate posts' and comments' counters.
// Usage: yarn babel bin/reindex_counters.js --help

const allTables = ['post_counters', 'comment_counters'];
const srcTables = {
  post_counters: 'posts',
  comment_counters: 'comments',
};
const ZERO_UID = '00000000-00000000-00000000-00000000';
const statusFile = path.join(__dirname, '../tmp/reindex_counters.json');

program
  .option('--batch-size <batch size>', 'batch size', (v) => parseInt(v, 10), 500)
  .option('--delay <delay>', 'delay between batches, milliseconds', (v) => parseInt(v, 10), 100)
  .option('--restart', 'start from the beginning and overwrite the existing counters');
program.parse(process.argv);

const [batchSize, delayMsec, restart] = [
  program.getOptionValue('batchSize'),
  program.getOptionValue('delay'),
  program.getOptionValue('restart'),
];

if (!isFinite(batchSize) || !isFinite(delayMsec)) {
  process.stderr.write(`⛔ Invalid program option\n`);
  program.help();
}

process.stdout.write(`Running with batch size of ${batchSize} and delay of ${delayMsec}\n`);
process.stdout.write(`Status file: ${statusFile}\n`);
process.stdout.write(`\n`);

(async () => {
  try {
    let lastUID = ZERO_UID;
    let [table] = allTables;

    if (!restart) {
      try {
        const statusText = await fs.readFile(statusFile, { encoding: 'utf8' });
        ({ lastUID, table } = JSON.parse(statusText));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw new Error(`Cannot read status from ${statusFile}: ${err.message}`);
        }

        process.stdout.write(`Status file is not found, starting from the beginning...\n`);
      }
    }

    if (!allTables.includes(table)) {
      throw new Error(`Unknown table name '${table}'`);
    }

    while (table) {
      process.stdout.write(`Processing ${table} starting from ${lastUID}...\n`);
      let processed = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const start = Date.now();

        const srcTable = srcTables[table];

        const ids = await dbAdapter.database.getCol(
          `select uid from ${srcTable} where uid > :lastUID order by uid limit :batchSize`,
          { lastUID, batchSize },
        );

        if (ids.length === 0) {
          break;
        }

        if (table === 'post_counters') {
          await dbAdapter.database.transaction(async (trx) => {
            // Lock 'comments' and 'likes' tables to prevent any updates
            await trx.raw(`lock table comments in share row exclusive mode`);
            await trx.raw(`lock table likes in share row exclusive mode`);

            await trx.raw(
              `insert into ${table} (post_id, comments_count, likes_count)
             select 
              p.uid as post_id,
              (select coalesce(count(*), 0)::int from comments where post_id = p.uid) as comments_count,
              (select coalesce(count(*), 0)::int from likes where post_id = p.uid) as likes_count
             from posts p where p.uid = any(:ids)
             on conflict (post_id) do 
              update set
                comments_count = excluded.comments_count,
                likes_count = excluded.likes_count`,
              { ids },
            );
          });
        }

        if (table === 'comment_counters') {
          await dbAdapter.database.transaction(async (trx) => {
            // Lock 'comment_likes' table to prevent any updates
            await trx.raw(`lock table comment_likes in share row exclusive mode`);

            await trx.raw(
              `insert into ${table} (comment_id, likes_count)
             select 
              c.uid as comment_id,
              (select coalesce(count(*), 0)::int from comment_likes where comment_id = c.id) as likes_count
             from comments c where c.uid = any(:ids)
             on conflict (comment_id) do 
              update set
                likes_count = excluded.likes_count`,
              { ids },
            );
          });
        }

        lastUID = ids[ids.length - 1];
        processed += ids.length;

        const percent = (parseInt(lastUID.slice(0, 2), 16) * 100) >> 8;
        const speed = Math.round((batchSize * 1000) / (Date.now() - start));

        process.stdout.write(
          `\tprocessed ${processed} ${srcTable} at ${speed} records/sec (${percent}% of total)\n`,
        );

        await saveStatus(lastUID);
        await setTimeout(delayMsec);
      }

      process.stdout.write(`All ${table} filled, starting VACUUM ANALYZE...\n`);
      await dbAdapter.database.raw(`vacuum analyze ${table}`);
      process.stdout.write(`Done with ${table}.\n`);

      table = allTables[allTables.indexOf(table) + 1];
      lastUID = ZERO_UID;
    }

    process.stdout.write(`All tables were processed.\n`);
    await fs.unlink(statusFile);

    process.exit(0);
  } catch (e) {
    process.stderr.write(`⛔ ERROR: ${e.message}\n`);
    process.exit(1);
  }
})();

async function saveStatus(lastUID, table) {
  await fs.mkdir(path.dirname(statusFile), { recursive: true });
  await fs.writeFile(statusFile, JSON.stringify({ lastUID, table }));
}
