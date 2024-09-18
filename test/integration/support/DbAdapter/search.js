/* eslint-env node, mocha */
/* global $pg_database */
import expect from 'unexpected';

import cleanDB from '../../../dbCleaner';
import { Post, User, dbAdapter, Comment } from '../../../../app/models';
import { createUsers } from '../../helpers/users';
import { createComment, createPost } from '../../helpers/posts-and-comments';

describe('Search', () => {
  const posts = [];
  function testSearch(testData) {
    for (const { query = '', viewerName = null, filter = () => true, comment = '' } of testData) {
      const description = [
        `should search by`,
        query ? `'${query}'` : 'empty',
        `query`,
        viewerName && `as ${viewerName}`,
        comment && `(${comment})`,
      ]
        .filter(Boolean)
        .join(' ');
      it(description, async () => {
        const viewer = viewerName ? await dbAdapter.getUserByUsername(viewerName) : null;
        const postIds = await dbAdapter.search(query, { viewerId: viewer ? viewer.id : undefined });
        const expected = posts.filter(filter).map((p) => p.id);
        expect(postIds, 'to equal', expected);
      });
    }
  }

  describe('Luna, Mars and Venus wrote two post each in their feeds', () => {
    let luna, mars, venus;
    let lunaFeed, marsFeed, venusFeed;

    before(async () => {
      await cleanDB($pg_database);

      luna = new User({ username: 'luna', password: 'pw' });
      mars = new User({ username: 'mars', password: 'pw' });
      venus = new User({ username: 'venus', password: 'pw' });
      await Promise.all([luna.create(), mars.create(), venus.create()]);

      [lunaFeed, marsFeed, venusFeed] = await Promise.all([
        luna.getPostsTimeline(),
        mars.getPostsTimeline(),
        venus.getPostsTimeline(),
      ]);

      for (let i = 0; i < 2; i++) {
        posts.push(
          new Post({
            body: `luna ${i ? 'second post' : 'post first'}`,
            userId: luna.id,
            timelineIds: [lunaFeed.id],
          }),
        );
        posts.push(
          new Post({
            body: `mars ${i ? 'second post' : 'post first'}`,
            userId: mars.id,
            timelineIds: [marsFeed.id],
          }),
        );
        posts.push(
          new Post({
            body: `venus ${i ? 'second post' : 'post first'}`,
            userId: venus.id,
            timelineIds: [venusFeed.id],
          }),
        );
      }

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        await post.create(); // eslint-disable-line no-await-in-loop

        const comment1 = new Comment({
          body: `Mars comment to post ${i + 1} ${post.userId === luna.id ? 'from Luna' : ''}`,
          userId: mars.id,
          postId: post.id,
        });
        const comment2 = new Comment({
          body: `Venus comment to post ${i + 1} ${post.userId === luna.id ? 'from Luna' : ''}`,
          userId: venus.id,
          postId: post.id,
        });
        await comment1.create(); // eslint-disable-line no-await-in-loop
        await comment2.create(); // eslint-disable-line no-await-in-loop
      }

      // We will receive posts in reverse order
      posts.reverse();
    });
    after(() => Promise.all(posts.map((post) => post.destroy())));

    describe('General text search', () => {
      testSearch([
        {
          query: '',
          comment: 'all posts',
        },
        {
          query: 'first',
          filter: (p) => /first/.test(p.body),
        },
        {
          query: 'first | luna',
          filter: (p) => /first/.test(p.body) || /luna/.test(p.body),
        },
        {
          query: 'first luna | mars',
          filter: (p) => /first/.test(p.body) && (/luna/.test(p.body) || /mars/.test(p.body)),
        },
        {
          query: '"luna post"',
          filter: (p) => /luna post/.test(p.body),
          comment: 'by phrase',
        },
        {
          query: '""',
          filter: () => false,
          comment: 'none posts for invalid query',
        },
        {
          query: '"',
          filter: () => false,
          comment: 'none posts for invalid query',
        },
        {
          query: '" "',
          filter: () => false,
          comment: 'none posts for invalid query',
        },
      ]);

      describe('Scoped (in posts and comments bodies) search', () => {
        testSearch([
          {
            query: 'venus',
            comment: 'all posts have "venus" in comments',
          },
          {
            query: 'mars venus',
            filter: () => false,
            comment: 'none of posts have both this words in body or comment',
          },
          {
            query: 'mars | venus',
            comment: 'all posts have "venus" in comments',
          },
          {
            query: 'in-body:venus',
            filter: (p) => p.userId === venus.id,
          },
          {
            query: 'in-comment: luna',
            filter: (p) => p.userId === luna.id,
          },
          {
            query: 'in-comment: venus -luna',
            filter: (p) => p.userId !== luna.id,
          },
          {
            query: 'in-comment:venus -in-body:luna',
            filter: (p) => p.userId !== luna.id,
            comment: `all posts (by "venus") except the Luna's (by "luna")`,
          },
        ]);

        describe('Luna bans Mars', () => {
          before(() => luna.ban(mars.username));
          after(() => luna.unban(mars.username));

          testSearch([
            {
              query: 'mars',
              viewerName: 'luna',
              filter: () => false,
              comment: 'nothing from Mars',
            },
            {
              query: 'in-comments: luna',
              viewerName: 'mars',
              filter: () => false,
              comment: 'Mars doesnt see Luna posts',
            },
            {
              query: 'in-comments: venus',
              viewerName: 'mars',
              filter: (p) => p.userId !== luna.id,
            },
          ]);
        });
      });
    });

    describe('Luna is public, Mars is protected, Venus is private', () => {
      before(async () => {
        await Promise.all([mars.update({ isProtected: '1' }), venus.update({ isPrivate: '1' })]);

        // Update posts data
        const newPosts = await dbAdapter.getPostsByIds(posts.map((p) => p.id));
        posts.length = 0;
        posts.push(...newPosts);
      });

      after(() =>
        Promise.all([
          mars.update({ isProtected: '0', isPrivate: '0' }),
          venus.update({ isProtected: '0', isPrivate: '0' }),
        ]),
      );

      describe('empty search string (find all available posts)', () => {
        testSearch([
          {
            filter: (p) => p.isProtected === '0',
            comment: 'public posts for anonymous',
          },
          {
            viewerName: 'luna',
            filter: (p) => p.isPrivate === '0',
            comment: 'public and protected posts',
          },
          {
            viewerName: 'venus',
            filter: () => true,
            comment: 'all posts',
          },
        ]);

        describe('Luna bans Mars', () => {
          before(() => luna.ban(mars.username));
          after(() => luna.unban(mars.username));

          testSearch([
            {
              filter: (p) => p.isProtected === '0',
              comment: 'public posts for anonymous',
            },
            {
              viewerName: 'luna',
              filter: (p) => p.userId === luna.id,
              comment: "Luna's posts only",
            },
            {
              viewerName: 'mars',
              filter: (p) => p.userId === mars.id,
              comment: "Mars' posts only",
            },
            {
              viewerName: 'venus',
              comment: 'all posts',
            },
          ]);
        });
      });
    });

    describe('Search condition operators', () => {
      describe('"me" and "in-my:" checking', () => {
        it("should throw error if anonymous uses the 'me' username", async () => {
          const test = dbAdapter.search('from:me');
          await expect(test, 'to be rejected with', /sign in/);
        });

        it("should throw error if anonymous uses the 'in-my:' condition", async () => {
          const test = dbAdapter.search('in-my:saves');
          await expect(test, 'to be rejected with', /sign in/);
        });

        it('should not throw error if anonymous uses someone username', async () => {
          const test = dbAdapter.search('from:luna');
          await expect(test, 'to be fulfilled');
        });

        it("should not throw error if logged in user uses the 'me' username", async () => {
          const test = dbAdapter.search('from:me', { viewerId: luna.id });
          await expect(test, 'to be fulfilled');
        });

        it("should not throw error if logged in user uses the 'in-my:' condition", async () => {
          const test = dbAdapter.search('in-my:saves', { viewerId: luna.id });
          await expect(test, 'to be fulfilled');
        });

        it('should not throw error if logged in user uses someone username', async () => {
          const test = dbAdapter.search('from:luna', { viewerId: luna.id });
          await expect(test, 'to be fulfilled');
        });
      });

      describe('from:, author:', () => {
        testSearch([
          {
            query: 'from:luna',
            filter: (p) => p.userId === luna.id,
          },
          {
            query: 'from:me',
            viewerName: 'luna',
            filter: (p) => p.userId === luna.id,
          },
          {
            query: 'from:luna from:luna',
            viewerName: 'luna',
            filter: (p) => p.userId === luna.id,
          },
          {
            query: 'from:me from:luna',
            viewerName: 'luna',
            filter: (p) => p.userId === luna.id,
          },
          {
            query: 'from:unknown',
            filter: () => false,
          },
          {
            query: 'from:unknown,luna',
            filter: (p) => p.userId === luna.id,
          },
          {
            query: 'from:mars from:luna',
            filter: () => false,
          },
          {
            query: 'author:mars',
            filter: () => true,
            comment: 'Mars commented everything',
          },
          {
            query: 'from:mars',
            filter: (p) => p.userId === mars.id,
          },
          {
            query: 'in-comments: author:mars',
            filter: () => true,
            comment: 'Mars commented everything',
          },
        ]);
      });

      describe('in:', () => {
        testSearch([
          {
            query: 'in:luna',
            filter: (p) => p.userId === luna.id,
          },
          {
            query: 'commented-by:mars -in:luna',
            filter: (p) => p.userId !== luna.id,
          },
          {
            query: 'commented-by:mars,unknown',
            filter: () => true,
          },
          {
            query: 'from:venus commented-by:mars',
            filter: (p) => p.userId === venus.id,
          },
          {
            query: 'from:venus -commented-by:mars',
            filter: () => false,
          },
          {
            query: 'in:jupiter luna',
            filter: () => false,
            comment: 'Non-existing user/group',
          },
          {
            query: 'in:luna,jupiter',
            filter: (p) => p.userId === luna.id,
          },
        ]);
        describe('Luna likes some post', () => {
          let likedPost;
          before(async () => {
            likedPost = posts[3]; // eslint-disable-line prefer-destructuring
            await likedPost.addLike(luna);
          });
          after(() => likedPost.removeLike(luna));

          testSearch([
            {
              query: 'commented-by:mars -liked-by:luna',
              filter: (p) => p.id !== likedPost.id,
            },
            {
              query: 'liked-by:luna',
              filter: (p) => p.id === likedPost.id,
            },
            {
              query: 'liked-by:luna,mars',
              filter: (p) => p.id === likedPost.id,
            },
          ]);
        });
      });

      describe('in-my:, to: (for directs)', () => {
        describe('Luna subscribed to Mars, saves and likes some posts', () => {
          let postsToLike, postsToSave;
          before(async () => {
            postsToLike = [posts[4], posts[3]];
            postsToSave = [posts[5], posts[2]];
            await luna.subscribeTo(mars);
            await Promise.all(postsToLike.map((post) => post.addLike(luna)));
            await Promise.all(postsToSave.map((post) => post.save(luna.id)));
          });

          after(async () => {
            await Promise.all(postsToSave.map((post) => post.unsave(luna.id)));
            await Promise.all(postsToLike.map((post) => post.removeLike(luna)));
            await luna.unsubscribeFrom(mars);
          });

          testSearch([
            {
              query: 'in-my:saves',
              viewerName: 'luna',
              filter: (p) => postsToSave.map((p1) => p1.id).includes(p.id),
            },
            {
              query: 'in-my:friends',
              viewerName: 'luna',
              filter: (p) => p.userId === mars.id || p.userId === luna.id,
            },
            {
              query: 'in-my:discussions',
              viewerName: 'luna',
              filter: (p) => p.userId === luna.id || postsToLike.map((p1) => p1.id).includes(p.id),
            },
            {
              query: '-in-my:discussions',
              viewerName: 'luna',
              filter: (p) => p.userId !== luna.id && !postsToLike.map((p1) => p1.id).includes(p.id),
            },
            {
              query: 'in-my:discussions in-body:mars',
              viewerName: 'luna',
              filter: (p) =>
                (p.userId === luna.id || postsToLike.map((p1) => p1.id).includes(p.id)) &&
                /mars/.test(p.body),
              comment: 'word with filter',
            },
            {
              query: 'in-my:something',
              viewerName: 'luna',
              filter: () => false,
              comment: 'invalid feed name',
            },
          ]);
        });

        describe('Luna sends direct to Mars', () => {
          let directPost;
          before(async () => {
            await luna.subscribeTo(mars);
            await mars.subscribeTo(luna);
            const lunaDirectFeed = await luna.getDirectsTimeline();
            const marsDirectFeed = await mars.getDirectsTimeline();
            directPost = new Post({
              body: 'Direct',
              userId: luna.id,
              timelineIds: [lunaDirectFeed.id, marsDirectFeed.id],
            });
            await directPost.create();
            posts.push(directPost);
          });
          after(async () => {
            posts.pop();
            await directPost.destroy();
            await mars.unsubscribeFrom(luna);
            await luna.unsubscribeFrom(mars);
          });

          testSearch([
            {
              query: 'in-my:directs',
              viewerName: 'luna',
              filter: (p) => p.id === directPost.id,
            },
            {
              query: 'in-my:directs',
              viewerName: 'mars',
              filter: (p) => p.id === directPost.id,
            },
            {
              query: 'in-my:directs -from:me',
              viewerName: 'luna',
              filter: () => false,
            },
            {
              query: 'to:mars',
              viewerName: 'luna',
              filter: (p) => p.id === directPost.id,
            },
            {
              query: 'to:me',
              viewerName: 'mars',
              filter: (p) => p.id === directPost.id,
            },
          ]);
        });
      });
    });
  });

  describe('Mentions, hashtags and links', () => {
    before(async () => {
      await cleanDB($pg_database);
      posts.length = 0;

      const luna = new User({ username: 'luna', password: 'pw' });
      await luna.create();
      const lunaFeed = await luna.getPostsTimeline();

      const newLunaPost = (body) => new Post({ body, userId: luna.id, timelineIds: [lunaFeed.id] });

      posts.push(newLunaPost(`#first post mentions @luna`));
      posts.push(newLunaPost(`#second post mentions @mars`));
      posts.push(newLunaPost(`third post #mentions @mars and @luna`));
      posts.push(newLunaPost(`fourth post mentions @celestials`));
      posts.push(newLunaPost(`post about $3 fruits: apple.com`));
      posts.push(newLunaPost(`a @time-and-space group with #long_hashtag #many-words`));
      posts.push(newLunaPost(`post that mentions https://get.adobe.com/ru/reader/ software`));
      posts.push(
        newLunaPost(
          `complex stuff post https4_(%D0%BC%D0%B0%D1%82%D0%B5%D0%BC%D0%B0%D1%82%D0%B8%D0%BA%D0%B0) /cc @luna`,
        ),
      );
      posts.push(newLunaPost(`let me https://lmgtfy.com/?q=freefeed`));

      for (const post of posts) {
        await post.create(); // eslint-disable-line no-await-in-loop
      }

      // We will receive posts in reverse order
      posts.reverse();
    });

    testSearch([
      {
        query: '@luna',
        filter: (p) => /@luna/.test(p.body),
      },
      {
        query: 'luna',
        filter: (p) => /@luna/.test(p.body),
      },
      {
        query: '@luna @mars',
        filter: (p) => /@luna/.test(p.body) && /@mars/.test(p.body),
      },
      {
        query: 'mention @celestials',
        filter: (p) => /@celestials/.test(p.body),
      },
      {
        query: 'meNtIOn @CeleStials',
        filter: (p) => /@celestials/.test(p.body),
      },
      {
        query: '"mention @celestials"',
        filter: () => false,
        comment: 'no post with exact wordforms',
      },
      {
        query: '"mentions @celestials"',
        filter: (p) => /@celestials/.test(p.body),
        comment: 'one post with exact exact wordforms',
      },
      {
        query: 'posts "mentions @celestials"',
        filter: (p) => /@celestials/.test(p.body),
        comment: 'word + exact exact wordforms',
      },
      {
        query: '"celestials"',
        filter: (p) => /@celestials/.test(p.body),
      },
      {
        query: '"@celestials mention"',
        filter: () => false,
        comment: 'no post with such word order',
      },
      {
        query: 'mention @celestial',
        filter: () => false,
        comment: 'mentions should be exact matched',
      },
      {
        query: '#first',
        filter: (p) => /#first/.test(p.body),
      },
      {
        query: '#mentions',
        filter: (p) => /#mentions/.test(p.body),
      },
      {
        query: '#mention',
        filter: () => false,
        comment: 'hashtag should be exact matched',
      },
      {
        query: 'apple.com',
        filter: (p) => /apple.com/.test(p.body),
      },
      {
        query: 'apple',
        filter: (p) => /apple.com/.test(p.body),
      },
      {
        query: 'com.apple',
        filter: () => false,
      },
      {
        query: 'fruit appl',
        filter: (p) => /apple.com/.test(p.body),
        comment: 'test wordforms',
      },
      {
        query: 'adobe.com',
        filter: (p) => /adobe.com/.test(p.body),
      },
      {
        query: 'adobe reader',
        filter: (p) => /adobe.com/.test(p.body),
      },
      {
        query: 'wikipedia',
        filter: (p) => /wikipedia/.test(p.body),
      },
      {
        query: 'wikipedia про математику',
        filter: (p) => /wikipedia/.test(p.body),
      },
      {
        query: 'freefeed',
        filter: (p) => /freefeed/.test(p.body),
      },
      {
        query: 'https://lmgtfy.com/?q=freefeed',
        filter: (p) => /freefeed/.test(p.body),
      },
      {
        query: 'time',
        filter: (p) => /time/.test(p.body),
      },
      {
        query: '@time-and-space',
        filter: (p) => /time/.test(p.body),
      },
      {
        query: '@timeandspace',
        filter: () => false,
      },
      {
        query: '#long-hashtag',
        filter: (p) => /time/.test(p.body),
      },
      {
        query: '#long_hashtag',
        filter: (p) => /time/.test(p.body),
      },
      {
        query: '#longhashtag',
        filter: (p) => /time/.test(p.body),
      },
      {
        query: 'long',
        filter: (p) => /time/.test(p.body),
      },
      {
        query: 'words',
        filter: (p) => /time/.test(p.body),
      },
      {
        query: 'ment*',
        filter: (p) => /ment/.test(p.body),
        comment: 'wildcard',
      },
      {
        query: '#ment*',
        filter: (p) => /#ment/.test(p.body),
        comment: 'wildcard in hashtag',
      },
      {
        query: 'com*',
        filter: (p) => /com/.test(p.body),
        comment: 'wildcard that contains full word',
      },
      {
        query: 'co*',
        filter: (p) => /\bco/.test(p.body),
        comment: 'short wildcard',
      },
      {
        query: 'mention + luna',
        filter: (p) => /first/.test(p.body),
        comment: 'plus operator',
      },
    ]);
  });

  describe('Comment likes (`cliked-by:`)', () => {
    let luna, mars, venus;

    before(async () => {
      await cleanDB($pg_database);

      luna = new User({ username: 'luna', password: 'pw' });
      mars = new User({ username: 'mars', password: 'pw' });
      venus = new User({ username: 'venus', password: 'pw' });
      await Promise.all([luna.create(), mars.create(), venus.create()]);

      const [lunaFeed, marsFeed] = await Promise.all([
        luna.getPostsTimeline(),
        mars.getPostsTimeline(),
      ]);

      // Remove all elements from the 'posts' array
      posts.length = 0;

      posts.push(
        new Post({
          body: `luna post`,
          userId: luna.id,
          timelineIds: [lunaFeed.id],
        }),
      );
      posts.push(
        new Post({
          body: `mars post`,
          userId: mars.id,
          timelineIds: [marsFeed.id],
        }),
      );

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        await post.create(); // eslint-disable-line no-await-in-loop

        const marsComment = new Comment({
          body: `Mars comment to post ${post.userId === luna.id ? 'from Luna' : 'from Mars'}`,
          userId: mars.id,
          postId: post.id,
        });
        const lunaComment = new Comment({
          body: `Luna comment to post ${post.userId === luna.id ? 'from Luna' : 'from Mars'}`,
          userId: luna.id,
          postId: post.id,
        });
        await marsComment.create(); // eslint-disable-line no-await-in-loop
        await lunaComment.create(); // eslint-disable-line no-await-in-loop

        // Luna likes Mars comment to her post
        if (post.userId === luna.id) {
          await marsComment.addLike(luna); // eslint-disable-line no-await-in-loop
        }

        // Venus likes all Mars comments
        await marsComment.addLike(venus); // eslint-disable-line no-await-in-loop
      }
    });
    after(() => Promise.all(posts.map((post) => post.destroy())));

    it('should search comment liked by Luna', async () => {
      const postIds = await dbAdapter.search('mars comment cliked-by:luna');
      expect(postIds, 'to equal', [posts[0].id]);
    });

    it('should search comment NOT liked by Luna', async () => {
      const postIds = await dbAdapter.search('mars comment -cliked-by:luna');
      expect(postIds, 'to equal', [posts[1].id]);
    });
  });

  describe('Search query complexity', () => {
    it('should throw error if query is too complex', async () => {
      const test = dbAdapter.search('The quick brown fox jumps over the lazy dog', {
        maxQueryComplexity: 5,
      });
      await expect(test, 'to be rejected with', /too complex/);
    });
  });

  describe('Short prefix search', () => {
    it('should throw error if prefix is empty', async () => {
      const test = dbAdapter.search('*', { minPrefixLength: 2 });
      await expect(test, 'to be rejected with', 'Minimum prefix length is 2');
    });

    it('should throw error if prefix is too short', async () => {
      const test = dbAdapter.search('x*', { minPrefixLength: 2 });
      await expect(test, 'to be rejected with', 'Minimum prefix length is 2');
    });
  });

  describe('The authorship operator', () => {
    let luna, mars, venus;
    let lunaPost, venusPost;

    before(async () => {
      await cleanDB($pg_database);

      [luna, mars, venus] = await createUsers(['luna', 'mars', 'venus']);
      // This post should not be found, even though it contains the word 'mars'
      lunaPost = await createPost(luna, 'luna post for mars');
      await createComment(mars, lunaPost, 'just a comment');

      // This post should be found because it contains the Mars' comment with the word 'mars'
      venusPost = await createPost(venus, 'venus post');
      await createComment(mars, venusPost, 'mars comment');
    });

    it(`should find posts by the 'mars by:mars' query`, async () => {
      const ids = await dbAdapter.search('mars by:mars');
      await expect(ids, 'to equal', [venusPost.id]);
    });

    it(`should find posts by the 'in-comments:mars by:mars' query`, async () => {
      const ids = await dbAdapter.search('in-comments:mars by:mars');
      await expect(ids, 'to equal', [venusPost.id]);
    });

    it(`should find posts by the 'in-comments: mars by:mars' query`, async () => {
      const ids = await dbAdapter.search('in-comments: mars by:mars');
      await expect(ids, 'to equal', [venusPost.id]);
    });

    it(`should find both of the posts by the 'in-comments: by:mars' query`, async () => {
      const ids = await dbAdapter.search('in-comments: by:mars');
      await expect(ids, 'to equal', [venusPost.id, lunaPost.id]);
    });
  });
});
