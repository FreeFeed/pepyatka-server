/* eslint-env node, mocha */
/* global $pg_database */
import expect from 'unexpected';

import cleanDB from '../../../dbCleaner';
import { dbAdapter } from '../../../../app/models';
import { createUsers } from '../../helpers/users';
import { createPost } from '../../helpers/posts-and-comments';

describe('Search by post privacy', () => {
  const posts = [];
  let luna, mars, venus;

  before(async () => {
    await cleanDB($pg_database);

    [luna, mars, venus] = await createUsers(['luna', 'mars', 'venus']);
    await luna.update({ isPrivate: '1' });
    await mars.update({ isProtected: '1' });

    posts.push(await createPost(luna, 'Post1'));
    posts.push(await createPost(mars, 'Post2'));
    posts.push(await createPost(venus, 'Post3'));
  });

  describe('Anonymous search', () => {
    it('should not return any private posts', async () => {
      const postIds = await dbAdapter.search('is:private');
      expect(postIds, 'to equal', []);
    });

    it('should not return any protected posts', async () => {
      const postIds = await dbAdapter.search('is:protected');
      expect(postIds, 'to equal', []);
    });

    it('should return only public posts', async () => {
      const postIds = await dbAdapter.search('is:public');
      expect(postIds, 'to equal', [posts[2].id]);
    });
  });

  describe('Authenticated search', () => {
    it('should return only private posts', async () => {
      const postIds = await dbAdapter.search('is:private', { viewerId: luna.id });
      expect(postIds, 'to equal', [posts[0].id]);
    });

    it('should return only protected posts', async () => {
      const postIds = await dbAdapter.search('is:protected', { viewerId: luna.id });
      expect(postIds, 'to equal', [posts[1].id]);
    });

    it('should return only public posts', async () => {
      const postIds = await dbAdapter.search('is:public', { viewerId: luna.id });
      expect(postIds, 'to equal', [posts[2].id]);
    });

    it('should return not public posts', async () => {
      const postIds = await dbAdapter.search('-is:public', { viewerId: luna.id });
      expect(postIds, 'to equal', [posts[1].id, posts[0].id]);
    });

    it('should return not protected posts', async () => {
      const postIds = await dbAdapter.search('-is:protected', { viewerId: luna.id });
      expect(postIds, 'to equal', [posts[2].id, posts[0].id]);
    });

    it('should return not private posts', async () => {
      const postIds = await dbAdapter.search('-is:private', { viewerId: luna.id });
      expect(postIds, 'to equal', [posts[2].id, posts[1].id]);
    });
  });
});
