/* eslint-env node, mocha */
/* global $pg_database */
import expect from 'unexpected';

import cleanDB from '../../dbCleaner';
import { getSingleton } from '../../../app/app';
import { DummyPublisher } from '../../../app/pubsub';
import { dbAdapter, PubSub } from '../../../app/models';
import {
  createUserAsync,
  createAndReturnPost,
  like,
  goPrivate,
  goProtected,
  mutualSubscriptions,
  fetchPost,
  createMockAttachmentAsync,
  updatePostAsync,
  hidePost,
  savePost,
  unsavePost,
  performJSONRequest,
  authHeaders,
  createTestUsers,
  sendRequestToSubscribe,
  acceptRequestToSubscribe,
  banUser,
  createTestUser,
  justCreatePost,
  justCreateComment,
} from '../functional_test_helper';
import { postsByIdsResponse } from '../schemaV2-helper';
import { API_VERSION_2, API_VERSION_3 } from '../../../app/api-versions';

describe('TimelinesControllerV2', () => {
  let app;
  let fetchPostOpenGraph;
  before(async () => {
    app = await getSingleton();
    fetchPostOpenGraph = postOpenGraphFetcher(app);
    PubSub.setPublisher(new DummyPublisher());
  });

  beforeEach(() => cleanDB($pg_database));

  describe('#postsV2', () => {
    describe('Luna wrote post, Mars is mutual friend, Venus is stranger', () => {
      let luna, mars, venus;
      let lunaPost;
      beforeEach(async () => {
        [luna, mars, venus] = await createTestUsers(['luna', 'mars', 'venus']);
        lunaPost = await justCreatePost(luna, 'Luna post');
        await mutualSubscriptions([luna, mars]);
      });

      async function expectCommentsFolding(
        nComments,
        expComments,
        expOmitted,
        allComments = false,
        apiVersion = API_VERSION_2,
      ) {
        const promises = [];

        for (let n = 0; n < nComments; n++) {
          promises.push(justCreateComment(luna, lunaPost.id, `Comment ${n + 1}`));
        }

        await Promise.all(promises);

        const post = await fetchPost(lunaPost.id, null, { allComments, apiVersion });
        expect(post.posts.comments, 'to have length', expComments);
        expect(post.posts.omittedComments, 'to equal', expOmitted);
        expect(post.posts.omittedCommentsOffset, 'to equal', expOmitted > 0 ? 1 : 0);
      }

      describe('Comments folding test', () => {
        describe('Folded comments', () => {
          it('should return post with 1 comment without folding', async () =>
            await expectCommentsFolding(1, 1, 0));
          it('should return post with 2 comments without folding', async () =>
            await expectCommentsFolding(2, 2, 0));
          it('should return post with 3 comments without folding', async () =>
            await expectCommentsFolding(3, 3, 0));
          it('should return post with 4 comments with folding', async () =>
            await expectCommentsFolding(4, 2, 2));
          it('should return post with 5 comments with folding', async () =>
            await expectCommentsFolding(5, 2, 3));
        });

        describe('Unfolded comments', () => {
          it('should return post with 1 comment without folding', async () =>
            await expectCommentsFolding(1, 1, 0, true));
          it('should return post with 2 comments without folding', async () =>
            await expectCommentsFolding(2, 2, 0, true));
          it('should return post with 3 comments without folding', async () =>
            await expectCommentsFolding(3, 3, 0, true));
          it('should return post with 4 comments without folding', async () =>
            await expectCommentsFolding(4, 4, 0, true));
          it('should return post with 5 comments without folding', async () =>
            await expectCommentsFolding(5, 5, 0, true));
        });
      });

      describe(`Comments folding test (v${API_VERSION_3})`, () => {
        describe('Folded comments', () => {
          it('should return post with 1 comment without folding', async () =>
            await expectCommentsFolding(1, 1, 0, false, API_VERSION_3));
          it('should return post with 2 comments without folding', async () =>
            await expectCommentsFolding(2, 2, 0, false, API_VERSION_3));
          it('should return post with 3 comments without folding', async () =>
            await expectCommentsFolding(3, 3, 0, false, API_VERSION_3));
          it('should return post with 4 comments without folding', async () =>
            await expectCommentsFolding(4, 4, 0, false, API_VERSION_3));
          it('should return post with 5 comments with folding', async () =>
            await expectCommentsFolding(5, 3, 2, false, API_VERSION_3));
          it('should return post with 6 comments with folding', async () =>
            await expectCommentsFolding(6, 3, 3, false, API_VERSION_3));
        });

        describe('Unfolded comments', () => {
          it('should return post with 1 comment without folding', async () =>
            await expectCommentsFolding(1, 1, 0, true, API_VERSION_3));
          it('should return post with 2 comments without folding', async () =>
            await expectCommentsFolding(2, 2, 0, true, API_VERSION_3));
          it('should return post with 3 comments without folding', async () =>
            await expectCommentsFolding(3, 3, 0, true, API_VERSION_3));
          it('should return post with 4 comments without folding', async () =>
            await expectCommentsFolding(4, 4, 0, true, API_VERSION_3));
          it('should return post with 5 comments without folding', async () =>
            await expectCommentsFolding(5, 5, 0, true, API_VERSION_3));
        });
      });

      describe('Likes folding test', () => {
        let users;
        beforeEach(async () => {
          const promises = [];

          for (let n = 0; n < 5; n++) {
            promises.push(createUserAsync(`username${n + 1}`, 'pw'));
          }

          users = await Promise.all(promises);
        });

        const expectFolding = async (nLikes, expLikes, expOmitted, allLikes = false) => {
          await Promise.all(users.slice(0, nLikes).map((u) => like(lunaPost.id, u.authToken)));
          const post = await fetchPost(lunaPost.id, null, { allLikes });
          expect(post.posts.likes, 'to have length', expLikes);
          expect(post.posts.omittedLikes, 'to equal', expOmitted);
        };

        describe('Folded likes', () => {
          it('should return post with 1 like without folding', async () =>
            await expectFolding(1, 1, 0));
          it('should return post with 2 likes without folding', async () =>
            await expectFolding(2, 2, 0));
          it('should return post with 3 likes without folding', async () =>
            await expectFolding(3, 3, 0));
          it('should return post with 4 likes without folding', async () =>
            await expectFolding(4, 4, 0));
          it('should return post with 5 likes with folding', async () =>
            await expectFolding(5, 3, 2));
        });

        describe('Unfolded likes', () => {
          it('should return post with 1 like without folding', async () =>
            await expectFolding(1, 1, 0, true));
          it('should return post with 2 likes without folding', async () =>
            await expectFolding(2, 2, 0, true));
          it('should return post with 3 likes without folding', async () =>
            await expectFolding(3, 3, 0, true));
          it('should return post with 4 likes without folding', async () =>
            await expectFolding(4, 4, 0, true));
          it('should return post with 5 likes without folding', async () =>
            await expectFolding(5, 5, 0, true));
        });

        describe('Likes order', () => {
          it('should keep likes order after unfolding', async () => {
            // 5 likes
            await Promise.all(users.slice(0, 5).map((u) => like(lunaPost.id, u.authToken)));
            const {
              posts: { likes: foldedLikes },
            } = await fetchPost(lunaPost.id, null, { allLikes: false });
            const {
              posts: { likes: unfoldedLikes },
            } = await fetchPost(lunaPost.id, null, { allLikes: true });
            expect(unfoldedLikes.slice(0, foldedLikes.length), 'to equal', foldedLikes);
          });
        });
      });

      describe('Luna is a public user', () => {
        it('should return post to anonymous', async () => {
          const post = await fetchPost(lunaPost.id);
          expect(post.posts.id, 'to be', lunaPost.id);
        });

        it('should return post to Luna', async () => {
          const post = await fetchPost(lunaPost.id, luna);
          expect(post.posts.id, 'to be', lunaPost.id);
        });

        it('should return post to Venus', async () => {
          const post = await fetchPost(lunaPost.id, venus);
          expect(post.posts.id, 'to be', lunaPost.id);
        });
      });

      describe('Luna is a protected user', () => {
        beforeEach(async () => await goProtected(luna));

        it('should not return post to anonymous', async () => {
          const resp = await fetchPost(lunaPost.id, null, { returnError: true });
          expect(resp, 'to satisfy', { status: 403 });
        });

        it('should return post to Luna', async () => {
          const post = await fetchPost(lunaPost.id, luna);
          expect(post.posts.id, 'to be', lunaPost.id);
        });

        it('should return post to Venus', async () => {
          const post = await fetchPost(lunaPost.id, venus);
          expect(post.posts.id, 'to be', lunaPost.id);
        });
      });

      describe('Luna is a private user', () => {
        beforeEach(async () => await goPrivate(luna));

        it('should not return post to anonymous', async () => {
          const resp = await fetchPost(lunaPost.id, null, { returnError: true });
          expect(resp, 'to satisfy', { status: 403 });
        });

        it('should return post to Luna', async () => {
          const post = await fetchPost(lunaPost.id, luna);
          expect(post.posts.id, 'to be', lunaPost.id);
        });

        it('should not return post to Venus', async () => {
          const resp = await fetchPost(lunaPost.id, venus, { returnError: true });
          expect(resp, 'to satisfy', { status: 403 });
        });

        it('should return post to Mars', async () => {
          const post = await fetchPost(lunaPost.id, mars);
          expect(post.posts.id, 'to be', lunaPost.id);
        });
      });

      describe('Open Graph test', () => {
        let lunaPostWithSpecialCharacters, lunaPostWithNewLines;

        beforeEach(async () => {
          [lunaPostWithSpecialCharacters, lunaPostWithNewLines] = await Promise.all([
            justCreatePost(luna, 'Test with tags <br>'),
            justCreatePost(luna, 'A\nB\nC'),
          ]);
        });

        describe('Luna is a public user', () => {
          it('should return information for a public post', async () => {
            const response = await fetchPostOpenGraph(lunaPost.id);
            response.should.include('og:title');
            response.should.include('luna');
            response.should.include('<meta property="og:description" content="Luna post" />');
          });

          it('should return information for a public post by its short id', async () => {
            const shortId = await lunaPost.getShortId();
            const response = await fetchPostOpenGraph(shortId);
            response.should.include('og:title');
            response.should.include('luna');
            response.should.include('<meta property="og:description" content="Luna post" />');
          });

          it('should escape special characters', async () => {
            const response = await fetchPostOpenGraph(lunaPostWithSpecialCharacters.id);
            response.should.include(
              '<meta property="og:description" content="Test with tags &lt;br&gt;" />',
            );
          });

          it('should support new lines', async () => {
            const response = await fetchPostOpenGraph(lunaPostWithNewLines.id);
            response.should.include('<meta property="og:description" content="A\nB\nC" />');
          });
        });

        describe('Luna is a protected user', () => {
          beforeEach(async () => await goProtected(luna));

          it('should not return any information for a protected post', async () => {
            const response = await fetchPostOpenGraph(lunaPost.id);
            response.should.be.empty;
          });
        });

        describe('Luna is a private user', () => {
          beforeEach(async () => await goPrivate(luna));

          it('should not return any information for a private post', async () => {
            const response = await fetchPostOpenGraph(lunaPost.id);
            response.should.be.empty;
          });
        });
      });
    });
    describe('Luna wrote post and 3 attachments', () => {
      let luna;
      let attId1, attId2, attId3;
      beforeEach(async () => {
        luna = await createUserAsync('luna', 'pw');
        luna.post = await justCreatePost(luna, 'Luna post');
        attId1 = (await createMockAttachmentAsync(luna)).id;
        attId2 = (await createMockAttachmentAsync(luna)).id;
        attId3 = (await createMockAttachmentAsync(luna)).id;
      });

      it('should return post with [1, 2, 3] attachments in the correct order', async () => {
        const postData = {
          body: luna.post.body,
          attachments: [attId1, attId2, attId3],
        };
        await updatePostAsync(luna, postData);
        const { posts } = await fetchPost(luna.post.id);
        expect(posts.attachments, 'to equal', postData.attachments);
      });

      it('should return post with [3, 1, 2] attachments in the correct order', async () => {
        const postData = {
          body: luna.post.body,
          attachments: [attId3, attId1, attId2],
        };
        await updatePostAsync(luna, postData);
        const { posts } = await fetchPost(luna.post.id);
        expect(posts.attachments, 'to equal', postData.attachments);
      });

      it('should return post after attachment deletion with attachments in the correct order', async () => {
        const postData = {
          body: luna.post.body,
          attachments: [attId3, attId1, attId2],
        };
        await updatePostAsync(luna, postData);
        postData.attachments = [attId3, attId2];
        await updatePostAsync(luna, postData);
        const { posts } = await fetchPost(luna.post.id);
        expect(posts.attachments, 'to equal', postData.attachments);
      });

      it('should return post after attachment addition with attachments in the correct order', async () => {
        const postData = {
          body: luna.post.body,
          attachments: [attId1, attId2],
        };
        await updatePostAsync(luna, postData);
        postData.attachments = [attId3, attId2, attId1];
        await updatePostAsync(luna, postData);
        const { posts } = await fetchPost(luna.post.id);
        expect(posts.attachments, 'to equal', postData.attachments);
      });

      it('should not allow to rebind attachment from post1 to new post', async () => {
        await updatePostAsync(luna, { body: luna.post.body, attachments: [attId1] });

        const resp = await performJSONRequest(
          'POST',
          '/v1/posts',
          { post: { body: 'Body', attachments: [attId1] }, meta: { feeds: [luna.username] } },
          authHeaders(luna),
        );

        expect(resp, 'to satisfy', { __httpCode: 403 });
      });

      it('should return information for a post', async () => {
        await updatePostAsync(luna, { body: luna.post.body, attachments: [attId1] });
        const att1 = await dbAdapter.getAttachmentById(attId1);
        const response = await fetchPostOpenGraph(luna.post.id);
        response.should.include('og:title');
        response.should.include('luna');
        response.should.include('<meta property="og:description" content="Luna post" />');
        response.should.include(
          `<meta property="og:image" content="${att1.getFileUrl('thumbnails')}" />`,
        );
        response.should.include('<meta property="og:image:width" ');
        response.should.include('<meta property="og:image:height" ');
      });

      describe('Luna wrote another post', () => {
        let post1, post2;
        beforeEach(async () => {
          post1 = luna.post;
          post2 = await justCreatePost(luna, 'Luna post 2');
        });

        it('should not allow to rebind attachment from post1 to post2', async () => {
          luna.post = post1;
          await updatePostAsync(luna, { body: post1.body, attachments: [attId1] });
          luna.post = post2;
          const resp = await updatePostAsync(luna, { body: post2.body, attachments: [attId1] });
          expect(resp.status, 'to be', 403);
        });
      });

      describe('Mars also wrote post', () => {
        let mars;
        beforeEach(async () => {
          mars = await createUserAsync('mars', 'pw');
          mars.post = await justCreatePost(mars, 'Mars post');
        });

        it('should not allow Mars to steal Luna attachments', async () => {
          const postData = {
            body: mars.post.body,
            attachments: [attId1, attId2],
          };
          const resp = await updatePostAsync(mars, postData);
          expect(resp.status, 'to be', 403);
        });
      });
    });

    describe('Luna wrote post and hide it', () => {
      let luna;
      beforeEach(async () => {
        luna = await createUserAsync('luna', 'pw');
        luna.post = await justCreatePost(luna, 'Luna post');
        await hidePost(luna.post.id, luna);
      });

      it('should return post to Luna with truthy isHidden property', async () => {
        const { posts } = await fetchPost(luna.post.id, luna);
        expect(posts, 'to have key', 'isHidden'); // it is true because of schema
      });
    });

    describe('Luna wrote post and save it', () => {
      let luna;
      beforeEach(async () => {
        luna = await createUserAsync('luna', 'pw');
        luna.post = await justCreatePost(luna, 'Luna post');
        await savePost(luna.post.id, luna);
      });

      it('should return post to Luna with truthy isSaved property', async () => {
        const { posts } = await fetchPost(luna.post.id, luna);
        expect(posts, 'to have key', 'isSaved'); // it is true because of schema
      });

      describe('Luna unsaved post', () => {
        beforeEach(async () => {
          await unsavePost(luna.post.id, luna);
        });

        it('should return post to Luna without isSaved property', async () => {
          const { posts } = await fetchPost(luna.post.id, luna);
          expect(posts, 'not to have key', 'isSaved'); // it is true because of schema
        });
      });
    });
  });

  describe('Posts by ids', () => {
    const nPosts = 10;
    let luna, mars, posts;
    beforeEach(async () => {
      [luna, mars] = await createTestUsers(['luna', 'mars']);
      posts = [];

      for (let n = 0; n < nPosts; n++) {
        // eslint-disable-next-line no-await-in-loop
        posts.push(await justCreatePost(n % 2 == 0 ? luna : mars, 'post'));
      }
    });

    it('should return several posts by ids', async () => {
      const postIds = posts.slice(0, 3).map((p) => p.id);
      const resp = await performJSONRequest('POST', '/v2/posts/byIds', { postIds });
      expect(resp, 'to satisfy', postsByIdsResponse);
      expect(resp, 'to satisfy', {
        posts: postIds.map((id) => ({ id })),
      });
    });

    it('should return all posts by ids', async () => {
      const postIds = posts.map((p) => p.id);
      const resp = await performJSONRequest('POST', '/v2/posts/byIds', { postIds });
      expect(resp, 'to satisfy', postsByIdsResponse);
      expect(resp, 'to satisfy', {
        posts: postIds.map((id) => ({ id })),
      });
    });

    it('should return only existing posts by ids', async () => {
      const postIds = posts.map((p) => p.id);
      postIds.push('00000000-0000-4000-8000-000000000001');
      postIds.push('00000000-0000-4000-8000-000000000002');
      postIds.push('00000000-0000-4000-8000-000000000003');
      const resp = await performJSONRequest('POST', '/v2/posts/byIds', { postIds });
      expect(resp, 'to satisfy', postsByIdsResponse);
      expect(resp, 'to satisfy', {
        posts: postIds.slice(0, -3).map((id) => ({ id })),
      });
    });

    describe('Luna bans Mars', () => {
      beforeEach(() => banUser(luna, mars));

      it(`should return only Marses posts to Mars`, async () => {
        const postIds = posts.map((p) => p.id);
        const resp = await performJSONRequest(
          'POST',
          '/v2/posts/byIds',
          { postIds },
          authHeaders(mars),
        );
        expect(resp, 'to satisfy', postsByIdsResponse);
        expect(resp, 'to satisfy', {
          posts: postIds.filter((_, i) => i % 2 === 1).map((id) => ({ id })),
        });
      });
    });

    describe('Luna becomes private', () => {
      beforeEach(() => goPrivate(luna));

      it(`should return only Marses posts to anonymous users`, async () => {
        const postIds = posts.map((p) => p.id);
        const resp = await performJSONRequest('POST', '/v2/posts/byIds', { postIds });
        expect(resp, 'to satisfy', postsByIdsResponse);
        expect(resp, 'to satisfy', {
          posts: postIds.filter((_, i) => i % 2 === 1).map((id) => ({ id })),
        });
      });

      it(`should return only Marses posts to Mars`, async () => {
        const postIds = posts.map((p) => p.id);
        const resp = await performJSONRequest(
          'POST',
          '/v2/posts/byIds',
          { postIds },
          authHeaders(mars),
        );
        expect(resp, 'to satisfy', postsByIdsResponse);
        expect(resp, 'to satisfy', {
          posts: postIds.filter((_, i) => i % 2 === 1).map((id) => ({ id })),
        });
      });

      it(`should return all posts to Luna`, async () => {
        const postIds = posts.map((p) => p.id);
        const resp = await performJSONRequest(
          'POST',
          '/v2/posts/byIds',
          { postIds },
          authHeaders(luna),
        );
        expect(resp, 'to satisfy', postsByIdsResponse);
        expect(resp, 'to satisfy', {
          posts: postIds.map((id) => ({ id })),
        });
      });

      describe('Mars subscribed to Luna', () => {
        beforeEach(async () => {
          await sendRequestToSubscribe(mars, luna);
          await acceptRequestToSubscribe(mars, luna);
        });

        it(`should return all posts to Mars`, async () => {
          const postIds = posts.map((p) => p.id);
          const resp = await performJSONRequest(
            'POST',
            '/v2/posts/byIds',
            { postIds },
            authHeaders(mars),
          );
          expect(resp, 'to satisfy', postsByIdsResponse);
          expect(resp, 'to satisfy', {
            posts: postIds.map((id) => ({ id })),
          });
        });
      });
    });
  });

  describe('Enable/disable post comments events', () => {
    let luna, postId;

    beforeEach(async () => {
      luna = await createTestUser('luna');
      postId = (await createAndReturnPost(luna, 'post')).id;
    });

    it(`should set 'notifyOfAllComments' to true`, async () => {
      const resp = await performJSONRequest(
        'POST',
        `/v2/posts/${postId}/notifyOfAllComments`,
        { enabled: true },
        authHeaders(luna),
      );
      expect(resp, 'to satisfy', {
        posts: { id: postId, notifyOfAllComments: true },
      });
    });

    it(`should set 'notifyOfAllComments' to false`, async () => {
      await performJSONRequest(
        'POST',
        `/v2/posts/${postId}/notifyOfAllComments`,
        { enabled: true },
        authHeaders(luna),
      );
      const resp = await performJSONRequest(
        'POST',
        `/v2/posts/${postId}/notifyOfAllComments`,
        { enabled: false },
        authHeaders(luna),
      );
      expect(resp, 'to satisfy', {
        posts: { id: postId, notifyOfAllComments: false },
      });
    });
  });
});

const postOpenGraphFetcher = (app) => async (postId) => {
  const res = await fetch(`${app.context.config.host}/v2/posts-opengraph/${postId}`);

  if (res.status !== 200) {
    expect.fail('HTTP error (code {0})', res.status);
  }

  return await res.text();
};
