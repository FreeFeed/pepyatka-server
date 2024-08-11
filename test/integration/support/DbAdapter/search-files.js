/* eslint-env node, mocha */
/* global $pg_database */
import expect from 'unexpected';

import cleanDB from '../../../dbCleaner';
import { User, dbAdapter } from '../../../../app/models';
import { createPost } from '../../helpers/posts-and-comments';

describe('Search by file types', () => {
  const posts = [];
  let luna;

  before(async () => {
    await cleanDB($pg_database);

    luna = new User({ username: 'luna', password: 'pw' });
    await luna.create();

    const imageFileId1 = await dbAdapter.createAttachment({
      fileName: 'image.jpg',
      fileSize: 1234,
      mimeType: 'image/jpeg',
      mediaType: 'image',
      fileExtension: 'jpg',
      userId: luna.id,
    });

    const imageFileId2 = await dbAdapter.createAttachment({
      fileName: 'image.png',
      fileSize: 1234,
      mimeType: 'image/png',
      mediaType: 'image',
      fileExtension: 'png',
      userId: luna.id,
    });

    const audioFileId1 = await dbAdapter.createAttachment({
      fileName: 'song.mp3',
      fileSize: 1234,
      mimeType: 'audio/mp3',
      mediaType: 'audio',
      fileExtension: 'mp3',
      userId: luna.id,
    });

    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      posts[i] = await createPost(luna, `post ${i}`);
    }

    await posts[0].linkAttachments([imageFileId1]);
    await posts[1].linkAttachments([imageFileId2, audioFileId1]);
    // post[2] has no attachments
  });

  it('should search posts with any attachments', async () => {
    const postIds = await dbAdapter.search('has:files');
    expect(postIds, 'to equal', [posts[1].id, posts[0].id]);
  });

  it('should search posts without any attachments', async () => {
    const postIds = await dbAdapter.search('-has:files');
    expect(postIds, 'to equal', [posts[2].id]);
  });

  it('should search posts with images', async () => {
    const postIds = await dbAdapter.search('has:images');
    expect(postIds, 'to equal', [posts[1].id, posts[0].id]);
  });

  it('should search posts with audio', async () => {
    const postIds = await dbAdapter.search('has:audio');
    expect(postIds, 'to equal', [posts[1].id]);
  });

  it('should search posts with files but without audio', async () => {
    const postIds = await dbAdapter.search('has:files -has:audio');
    expect(postIds, 'to equal', [posts[0].id]);
  });

  it('should search posts with images but without audio', async () => {
    const postIds = await dbAdapter.search('has:images -has:audio');
    expect(postIds, 'to equal', [posts[0].id]);
  });
});
