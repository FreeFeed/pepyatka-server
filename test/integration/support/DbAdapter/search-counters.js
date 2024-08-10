/* eslint-disable no-await-in-loop */
/* eslint-env node, mocha */
/* global $pg_database */
import expect from 'unexpected';

import cleanDB from '../../../dbCleaner';
import { dbAdapter } from '../../../../app/models';
import { createComment, createPost } from '../../helpers/posts-and-comments';
import { createNUsers, createUser } from '../../helpers/users';

describe('Search by counters', () => {
  describe('Comments counts', () => {
    const posts = [];

    before(async () => {
      await cleanDB($pg_database);

      const luna = await createUser('luna');

      for (let i = 0; i < 4; i++) {
        posts.push(await createPost(luna, `Post ${i}`));
      }

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];

        // 0, 2, 4, 6
        for (let j = 0; j < i * 2; j++) {
          await createComment(luna, post, 'Comment body');
        }
      }
    });

    it('should find post without comments', async () => {
      const postIds = await dbAdapter.search('comments:0');
      expect(postIds, 'to equal', [posts[0].id]);
    });

    it('should find post with <=2 comments', async () => {
      const postIds = await dbAdapter.search('comments:<=2');
      expect(postIds, 'to equal', [posts[1].id, posts[0].id]);
    });

    it('should find post with >=3 comments', async () => {
      const postIds = await dbAdapter.search('comments:>=3');
      expect(postIds, 'to equal', [posts[3].id, posts[2].id]);
    });

    it('should find post with 3..5 comments', async () => {
      const postIds = await dbAdapter.search('comments:3..5');
      expect(postIds, 'to equal', [posts[2].id]);
    });

    it('should find post with 3..5 comments as two conditions', async () => {
      const postIds = await dbAdapter.search('comments:>=3 comments:<=5');
      expect(postIds, 'to equal', [posts[2].id]);
    });
  });

  describe('Likes counts', () => {
    const posts = [];

    before(async () => {
      await cleanDB($pg_database);

      const luna = await createUser('luna');
      const users = await createNUsers(6);

      for (let i = 0; i < 4; i++) {
        posts.push(await createPost(luna, `Post ${i}`));
      }

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];

        // 0, 2, 4, 6
        for (let j = 0; j < i * 2; j++) {
          await post.addLike(users[j]);
        }
      }
    });

    it('should find post without likes', async () => {
      const postIds = await dbAdapter.search('likes:0');
      expect(postIds, 'to equal', [posts[0].id]);
    });

    it('should find post with <=2 likes', async () => {
      const postIds = await dbAdapter.search('likes:<=2');
      expect(postIds, 'to equal', [posts[1].id, posts[0].id]);
    });

    it('should find post with >=3 likes', async () => {
      const postIds = await dbAdapter.search('likes:>=3');
      expect(postIds, 'to equal', [posts[3].id, posts[2].id]);
    });

    it('should find post with 3..5 likes', async () => {
      const postIds = await dbAdapter.search('likes:3..5');
      expect(postIds, 'to equal', [posts[2].id]);
    });

    it('should find post with 3..5 likes as two conditions', async () => {
      const postIds = await dbAdapter.search('likes:>=3 likes:<=5');
      expect(postIds, 'to equal', [posts[2].id]);
    });
  });

  describe('Comment likes counts', () => {
    const posts = [];

    before(async () => {
      await cleanDB($pg_database);

      const luna = await createUser('luna');
      const users = await createNUsers(6);

      for (let i = 0; i < 4; i++) {
        posts.push(await createPost(luna, `Post ${i}`));
      }

      for (let i = 0; i < posts.length; i++) {
        const comment = await createComment(luna, posts[i], 'Comment body');

        // 0, 2, 4, 6
        for (let j = 0; j < i * 2; j++) {
          await comment.addLike(users[j]);
        }
      }
    });

    it('should find comment without likes', async () => {
      const postIds = await dbAdapter.search('clikes:0');
      expect(postIds, 'to equal', [posts[0].id]);
    });

    it('should find comment with <=2 likes', async () => {
      const postIds = await dbAdapter.search('clikes:<=2');
      expect(postIds, 'to equal', [posts[1].id, posts[0].id]);
    });

    it('should find comment with >=3 likes', async () => {
      const postIds = await dbAdapter.search('clikes:>=3');
      expect(postIds, 'to equal', [posts[3].id, posts[2].id]);
    });

    it('should find comment with 3..5 likes', async () => {
      const postIds = await dbAdapter.search('clikes:3..5');
      expect(postIds, 'to equal', [posts[2].id]);
    });

    it('should find comment with 3..5 likes as two conditions', async () => {
      const postIds = await dbAdapter.search('clikes:>=3 clikes:<=5');
      expect(postIds, 'to equal', [posts[2].id]);
    });
  });
});
