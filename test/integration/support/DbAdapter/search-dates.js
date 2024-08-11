/* eslint-env node, mocha */
/* global $pg_database */
import expect from 'unexpected';

import cleanDB from '../../../dbCleaner';
import { Post, User, dbAdapter, Comment } from '../../../../app/models';

describe('Search by dates', () => {
  const posts = [];
  let luna;

  before(async () => {
    await cleanDB($pg_database);

    luna = new User({ username: 'luna', password: 'pw' });
    await luna.create();
    const lunaFeed = await luna.getPostsTimeline();

    for (let i = 0; i < 3; i++) {
      const post = new Post({
        body: `post ${i}`,
        userId: luna.id,
        timelineIds: [lunaFeed.id],
      });
      posts.push(post);
    }

    await Promise.all(posts.map((post) => post.create()));

    for (let i = 0; i < posts.length; i++) {
      // Posts was created at Jan 1, 2, and 3 2020

      // eslint-disable-next-line no-await-in-loop
      await dbAdapter.database.raw(`update posts set created_at = :date where uid = :uid`, {
        uid: posts[i].id,
        date: `2020-01-0${i + 1} 11:12:13Z`,
      });

      // Every post has 3 comments created ath the same day, day after and day after that:
      // Jan 1   Jan 2  Jan 3  Jan 4  Jan 5
      // Post1
      // └Comm1  Comm2  Comm3
      //         Post2
      //         └Comm1 Comm2  Comm3
      //                Post3
      //                └Comm1 Comm2  Comm3
      for (let j = 0; j < 3; j++) {
        const comment = new Comment({
          body: `comment ${j}`,
          userId: luna.id,
          postId: posts[i].id,
        });
        // eslint-disable-next-line no-await-in-loop
        await comment.create();
        // eslint-disable-next-line no-await-in-loop
        await dbAdapter.database.raw(`update comments set created_at = :date where uid = :uid`, {
          uid: comment.id,
          date: `2020-01-0${i + j + 1} 12:13:14Z`,
        });
      }
    }
  });

  it('should be possible to search by the exact date of content', async () => {
    const postIds = await dbAdapter.search('date:2020-01-02');
    expect(postIds, 'to equal', [posts[1].id, posts[0].id]);
  });

  it('should be possible to search by the exact date of content using `=`', async () => {
    const postIds = await dbAdapter.search('date:=2020-01-02');
    expect(postIds, 'to equal', [posts[1].id, posts[0].id]);
  });

  it('should be possible to search by the content date range', async () => {
    const postIds = await dbAdapter.search('date:>2020-01-03');
    expect(postIds, 'to equal', [posts[2].id, posts[1].id]);
  });

  it('should be possible to search by the exact date of post', async () => {
    const postIds = await dbAdapter.search('post-date:2020-01-02');
    expect(postIds, 'to equal', [posts[1].id]);
  });

  it('should be possible to search by the post date range', async () => {
    const postIds = await dbAdapter.search('post-date:>2020-01-02');
    expect(postIds, 'to equal', [posts[2].id]);
  });

  it('should be possible to search by the exact date of comment', async () => {
    const postIds = await dbAdapter.search('in-comments: date:2020-01-04');
    expect(postIds, 'to equal', [posts[2].id, posts[1].id]);
  });

  it('should be possible to search by the exact date of comment using text', async () => {
    const postIds = await dbAdapter.search('comment date:2020-01-04');
    expect(postIds, 'to equal', [posts[2].id, posts[1].id]);
  });

  it('should be possible to search by the negated date of comment', async () => {
    const postIds = await dbAdapter.search('comment -date:2020-01-01..2020-01-03');
    // posts[0] has all comments created on this interval
    expect(postIds, 'to equal', [posts[2].id, posts[1].id]);
  });

  it('should be possible to use short date syntax', async () => {
    const postIds = await dbAdapter.search('comment date:2020-01');
    expect(postIds, 'to equal', [posts[2].id, posts[1].id, posts[0].id]);
  });
});
