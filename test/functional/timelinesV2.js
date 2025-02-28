/* eslint-env node, mocha */
/* global $pg_database */
import expect from 'unexpected';
import _ from 'lodash';

import cleanDB from '../dbCleaner';
import { getSingleton } from '../../app/app';
import { DummyPublisher } from '../../app/pubsub';
import {
  PubSub,
  dbAdapter,
  HOMEFEED_MODE_CLASSIC,
  HOMEFEED_MODE_FRIENDS_ONLY,
  HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY,
} from '../../app/models';

import {
  createUserAsync,
  createAndReturnPost,
  subscribeToAsync,
  like,
  createCommentAsync,
  banUser,
  goPrivate,
  goProtected,
  sendRequestToSubscribe,
  acceptRequestToSubscribe,
  hidePost,
  createGroupAsync,
  createAndReturnPostToFeed,
  mutualSubscriptions,
  fetchTimeline,
  savePost,
  createTestUsers,
  unsavePost,
  justCreatePost,
  justCreateComment,
} from './functional_test_helper';

describe('TimelinesControllerV2', () => {
  let app;

  before(async () => {
    app = await getSingleton();
    PubSub.setPublisher(new DummyPublisher());
  });

  beforeEach(() => cleanDB($pg_database));

  describe('#home', () => {
    it('should reject unauthenticated users', async () => {
      const response = await fetch(`${app.context.config.host}/v2/timelines/home`);
      expect(response, 'to satisfy', { status: 401 });
      const data = await response.json();
      expect(data, 'to have key', 'err');
    });

    describe('Viewer Luna', () => {
      let luna;
      beforeEach(async () => (luna = await createUserAsync('luna', 'pw')));

      it('should return proper structure for authenticated user', async () => {
        await fetchHomefeed(luna);
      });

      it('should return empty timeline for newborn user', async () => {
        const homefeed = await fetchHomefeed(luna);
        expect(homefeed.posts, 'to be empty');
        expect(homefeed.comments, 'to be empty');
        expect(homefeed.attachments, 'to be empty');
      });

      it("should return timeline with one viewer's post", async () => {
        const post = await createAndReturnPost(luna, 'Luna post');
        const homefeed = await fetchHomefeed(luna);
        expect(homefeed.posts, 'to have length', 1);
        expect(homefeed.posts[0].id, 'to be', post.id);
      });

      it("should return timeline with one private viewer's post", async () => {
        await goPrivate(luna);
        const post = await createAndReturnPost(luna, 'Luna post');
        const homefeed = await fetchHomefeed(luna);
        expect(homefeed.posts, 'to have length', 1);
        expect(homefeed.posts[0].id, 'to be', post.id);
      });

      describe('Luna subscribed to Mars and not subscribed to Venus', () => {
        let mars;
        let venus;
        beforeEach(async () => {
          mars = await createUserAsync('mars', 'pw');
          venus = await createUserAsync('venus', 'pw');
          await subscribeToAsync(luna, mars);
        });

        it('should return timeline with Marses post', async () => {
          const post = await createAndReturnPost(mars, 'Mars post');

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 1);
          expect(homefeed.timelines.posts[0], 'to be', post.id);
        });

        it('should return timeline with newest posts at first', async () => {
          const post1 = await createAndReturnPost(mars, 'Mars post');
          const post2 = await createAndReturnPost(luna, 'Luna post');

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 2);
          expect(homefeed.timelines.posts[0], 'to be', post2.id);
          expect(homefeed.timelines.posts[1], 'to be', post1.id);
        });

        it('should return timeline with updated (by comment) posts at first', async () => {
          const post1 = await createAndReturnPost(mars, 'Mars post');
          const post2 = await createAndReturnPost(luna, 'Luna post');
          await createCommentAsync(mars, post1.id, 'Comment');

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 2);
          expect(homefeed.timelines.posts[0], 'to be', post1.id);
          expect(homefeed.timelines.posts[1], 'to be', post2.id);
          expect(homefeed.comments, 'to have length', 1);
        });

        it('should return timeline with post commented by friend', async () => {
          const post1 = await createAndReturnPost(mars, 'Mars post');
          const post2 = await createAndReturnPost(luna, 'Luna post');
          const post3 = await createAndReturnPost(venus, 'Venus post');
          await createCommentAsync(mars, post3.id, 'Comment');

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 3);
          expect(homefeed.timelines.posts[0], 'to be', post3.id);
          expect(homefeed.timelines.posts[1], 'to be', post2.id);
          expect(homefeed.timelines.posts[2], 'to be', post1.id);
          expect(homefeed.comments, 'to have length', 1);
        });

        it('should not return post commented by friend in "friends-only" mode', async () => {
          const post1 = await createAndReturnPost(mars, 'Mars post');
          const post2 = await createAndReturnPost(luna, 'Luna post');
          const post3 = await createAndReturnPost(venus, 'Venus post');
          await createCommentAsync(mars, post3.id, 'Comment');

          const homefeed = await fetchHomefeed(luna, HOMEFEED_MODE_FRIENDS_ONLY);
          expect(homefeed.timelines.posts, 'to equal', [post2.id, post1.id]);
          expect(homefeed.comments, 'to have length', 0);
        });

        it('should return timeline with post liked by friend at first place (local bump)', async () => {
          const post1 = await createAndReturnPost(venus, 'Venus post');
          const post2 = await createAndReturnPost(mars, 'Mars post');
          const post3 = await createAndReturnPost(luna, 'Luna post');
          await like(post1.id, mars.authToken);

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 3);
          expect(homefeed.timelines.posts[0], 'to be', post1.id);
          expect(homefeed.timelines.posts[1], 'to be', post3.id);
          expect(homefeed.timelines.posts[2], 'to be', post2.id);
          const venusPost = homefeed.posts.find((p) => p.id === post1.id);
          expect(venusPost.likes, 'to have length', 1);
        });

        it('should not return post liked by friend in "friends-only" mode', async () => {
          const post1 = await createAndReturnPost(mars, 'Mars post');
          const post2 = await createAndReturnPost(luna, 'Luna post');
          const post3 = await createAndReturnPost(venus, 'Venus post');
          await like(post3.id, mars.authToken);

          const homefeed = await fetchHomefeed(luna, HOMEFEED_MODE_FRIENDS_ONLY);
          expect(homefeed.timelines.posts, 'to equal', [post2.id, post1.id]);
        });

        it('should return timeline without post of banned user', async () => {
          const post1 = await createAndReturnPost(venus, 'Venus post');
          const post2 = await createAndReturnPost(mars, 'Mars post');
          const post3 = await createAndReturnPost(luna, 'Luna post');
          await like(post1.id, mars.authToken);
          await banUser(venus, luna);

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 2);
          expect(homefeed.timelines.posts[0], 'to be', post3.id);
          expect(homefeed.timelines.posts[1], 'to be', post2.id);
        });

        it('should return timeline without post of user who is banned viewer', async () => {
          const post1 = await createAndReturnPost(venus, 'Venus post');
          const post2 = await createAndReturnPost(mars, 'Mars post');
          const post3 = await createAndReturnPost(luna, 'Luna post');
          await like(post1.id, mars.authToken);
          await banUser(luna, venus);

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 2);
          expect(homefeed.timelines.posts[0], 'to be', post3.id);
          expect(homefeed.timelines.posts[1], 'to be', post2.id);
        });

        it('should return timeline without like and with hidden comment of banned user', async () => {
          const post = await createAndReturnPost(mars, 'Mars post');
          await banUser(luna, venus);
          await createCommentAsync(venus, post.id, 'Comment');
          await like(post.id, venus.authToken);

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.posts, 'to have length', 1);
          expect(homefeed.posts[0].comments, 'to be empty');
          expect(homefeed.posts[0].likes, 'to be empty');
        });

        it('hidden posts should have a isHidden property', async () => {
          const post1 = await createAndReturnPost(mars, 'Mars post');
          const post2 = await createAndReturnPost(luna, 'Luna post');
          await hidePost(post1.id, luna);

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 2);
          expect(homefeed.timelines.posts[0], 'to be', post2.id);
          expect(homefeed.timelines.posts[1], 'to be', post1.id);
          const marsPost = homefeed.posts.find((p) => p.id === post1.id);
          expect(marsPost, 'to have key', 'isHidden');
          expect(marsPost.isHidden, 'to be', true);
        });

        it('saved posts should have a isSaved property', async () => {
          const post1 = await createAndReturnPost(mars, 'Mars post');
          const post2 = await createAndReturnPost(luna, 'Luna post');
          await savePost(post1.id, luna);

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.timelines.posts, 'to have length', 2);
          expect(homefeed.timelines.posts[0], 'to be', post2.id);
          expect(homefeed.timelines.posts[1], 'to be', post1.id);
          const marsPost = homefeed.posts.find((p) => p.id === post1.id);
          expect(marsPost, 'to have key', 'isSaved');
          expect(marsPost.isSaved, 'to be', true);
        });

        describe('Luna have a private feed', () => {
          beforeEach(async () => {
            await goPrivate(luna);
          });

          it('should return timeline with her own post', async () => {
            const post = await createAndReturnPost(luna, 'Luna post');

            const homefeed = await fetchHomefeed(luna);
            expect(homefeed.timelines.posts, 'to have length', 1);
            expect(homefeed.timelines.posts[0], 'to be', post.id);
          });

          it('should return timeline with post liked by Luna', async () => {
            const post = await createAndReturnPost(venus, 'Venus post');
            await like(post.id, luna.authToken);

            const homefeed = await fetchHomefeed(luna);
            expect(homefeed.timelines.posts, 'to have length', 1);
            expect(homefeed.timelines.posts[0], 'to be', post.id);
          });

          it('should not return post liked by Luna in "friends-only" mode', async () => {
            const post = await createAndReturnPost(venus, 'Venus post');
            await like(post.id, luna.authToken);

            const homefeed = await fetchHomefeed(luna, HOMEFEED_MODE_FRIENDS_ONLY);
            expect(homefeed.timelines.posts, 'to be empty');
          });

          it('should return timeline with post commented by Luna', async () => {
            const post = await createAndReturnPost(venus, 'Venus post');
            await createCommentAsync(luna, post.id, 'Comment');

            const homefeed = await fetchHomefeed(luna);
            expect(homefeed.timelines.posts, 'to have length', 1);
            expect(homefeed.timelines.posts[0], 'to be', post.id);
          });

          it('should not return post commented by Luna in "friends-only" mode', async () => {
            const post = await createAndReturnPost(venus, 'Venus post');
            await createCommentAsync(luna, post.id, 'Comment');

            const homefeed = await fetchHomefeed(luna, HOMEFEED_MODE_FRIENDS_ONLY);
            expect(homefeed.timelines.posts, 'to be empty');
          });
        });

        describe('Venus have a private feed, Mars is subscribed to Venus', () => {
          beforeEach(async () => {
            await goPrivate(venus);
            await sendRequestToSubscribe(mars, venus);
            await acceptRequestToSubscribe(mars, venus);
          });

          it('should return timeline without posts from Venus liked by Mars', async () => {
            const post = await createAndReturnPost(venus, 'Venus post');
            await like(post.id, mars.authToken);

            const homefeed = await fetchHomefeed(luna);
            expect(homefeed.timelines.posts, 'to have length', 0);
          });

          it('should return timeline without posts from Venus commented by Mars', async () => {
            const post = await createAndReturnPost(venus, 'Venus post');
            await createCommentAsync(mars, post.id, 'Comment');

            const homefeed = await fetchHomefeed(luna);
            expect(homefeed.timelines.posts, 'to have length', 0);
          });
        });

        describe('Luna subscribed to Selenites group and not subscribed to Celestials group', () => {
          let selenitesPost, celestialsPost, celestials;

          beforeEach(async () => {
            const selenites = await createGroupAsync(venus, 'selenites');
            celestials = await createGroupAsync(venus, 'celestials');
            await subscribeToAsync(luna, selenites);

            selenitesPost = await justCreatePost(venus, 'Post', ['selenites']);
            celestialsPost = await justCreatePost(venus, 'Post', ['celestials']);
          });

          it('should return timeline without posts from Celestials group', async () => {
            await like(celestialsPost.id, mars.authToken);
            await like(selenitesPost.id, mars.authToken);

            const homefeed = await fetchHomefeed(luna);
            expect(homefeed.timelines.posts, 'to have length', 1);
            expect(homefeed.timelines.posts[0], 'to equal', selenitesPost.id);
          });

          it('should return timeline with liked posts from Celestials group in "friends-all-activity" mode', async () => {
            await like(celestialsPost.id, mars.authToken);
            await like(selenitesPost.id, mars.authToken);

            const homefeed = await fetchHomefeed(luna, HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY);
            expect(homefeed.timelines.posts, 'to equal', [celestialsPost.id, selenitesPost.id]);
          });

          it('should return timeline with Mars posts from Celestials group in "friends-all-activity" mode', async () => {
            await subscribeToAsync(mars, celestials);
            const marsCelestialsPost = await createAndReturnPostToFeed(
              { username: 'celestials' },
              mars,
              'Post',
            );

            const homefeed = await fetchHomefeed(luna, HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY);
            expect(homefeed.timelines.posts, 'to equal', [marsCelestialsPost.id, selenitesPost.id]);
          });
        });
      });

      describe('Luna blocked Mars, their are both in group Selenites', () => {
        let mars;
        let venus;
        beforeEach(async () => {
          mars = await createUserAsync('mars', 'pw');
          venus = await createUserAsync('venus', 'pw');
          const selenites = await createGroupAsync(venus, 'selenites');
          await subscribeToAsync(luna, selenites);
          await subscribeToAsync(mars, selenites);
          await banUser(mars, luna);
        });

        it('should return timeline without posts of Mars in Selenites group', async () => {
          await createAndReturnPostToFeed({ username: 'selenites' }, mars, 'Post');

          const homefeed = await fetchHomefeed(luna);
          expect(homefeed.posts, 'to be empty');
        });

        it('should return Mars timeline without posts of Luna in Selenites group', async () => {
          await createAndReturnPostToFeed({ username: 'selenites' }, luna, 'Post');

          const homefeed = await fetchHomefeed(mars);
          expect(homefeed.posts, 'to be empty');
        });
      });
    });
  });

  describe('#discussions', () => {
    it('should reject unauthenticated users', async () => {
      const response = await fetch(`${app.context.config.host}/v2/timelines/filter/discussions`);
      expect(response, 'to satisfy', { status: 401 });
      const data = await response.json();
      expect(data, 'to have key', 'err');
    });

    describe('Viewer Luna', () => {
      let luna, mars;
      let marsPostLikedByLuna, marsPostCommentedByLuna, lunaPost;
      beforeEach(async () => {
        luna = await createUserAsync('luna', 'pw');
        mars = await createUserAsync('mars', 'pw');
        marsPostLikedByLuna = await justCreatePost(mars, 'Mars post 1');
        marsPostCommentedByLuna = await justCreatePost(mars, 'Mars post 2');
        lunaPost = await justCreatePost(luna, 'Luna post');
        await justCreateComment(luna, marsPostCommentedByLuna.id, 'Comment');
        await like(marsPostLikedByLuna.id, luna.authToken);
      });

      it('should return timeline with posts commented or liked by Luna', async () => {
        const feed = await fetchMyDiscussions(luna);
        expect(feed.timelines.posts, 'to equal', [
          marsPostCommentedByLuna.id,
          marsPostLikedByLuna.id,
        ]);
      });

      it('should return timeline with posts authored, commented or liked by Luna', async () => {
        const feed = await fetchMyDiscussionsWithMyPosts(luna);
        expect(feed.timelines.posts, 'to equal', [
          marsPostCommentedByLuna.id,
          lunaPost.id,
          marsPostLikedByLuna.id,
        ]);
      });

      describe('Mars going private', () => {
        beforeEach(async () => {
          await goPrivate(mars);
        });

        it('should return timeline without private posts commented or liked by Luna', async () => {
          const feed = await fetchMyDiscussions(luna);
          expect(feed.timelines.posts, 'to be empty');
        });

        it('should return timeline with posts authored by Luna', async () => {
          const feed = await fetchMyDiscussionsWithMyPosts(luna);
          expect(feed.timelines.posts, 'to equal', [lunaPost.id]);
        });
      });
    });
  });

  describe('#directs', () => {
    it('should reject unauthenticated users', async () => {
      const response = await fetch(`${app.context.config.host}/v2/timelines/filter/directs`);
      expect(response, 'to satisfy', { status: 401 });
      const data = await response.json();
      expect(data, 'to have key', 'err');
    });

    describe('Luna is a friend of Mars', () => {
      let luna, mars;
      let postLunaToMars, postMarsToLuna;
      beforeEach(async () => {
        luna = await createUserAsync('luna', 'pw');
        mars = await createUserAsync('mars', 'pw');
        await mutualSubscriptions([luna, mars]);
        postLunaToMars = await justCreatePost(luna, 'Post', ['luna', 'mars']);
        postMarsToLuna = await justCreatePost(mars, 'Post', ['luna', 'mars']);
      });

      it('should return timeline with directs from Luna and to Luna', async () => {
        const feed = await fetchDirects(luna);
        expect(feed.timelines.posts, 'to have length', 2);
        expect(feed.timelines.posts[0], 'to equal', postMarsToLuna.id);
        expect(feed.timelines.posts[1], 'to equal', postLunaToMars.id);
      });

      describe('Mars blocked Luna', () => {
        beforeEach(async () => {
          await banUser(luna, mars);
        });

        it('should return timeline without posts from banned user', async () => {
          const feed = await fetchDirects(luna);
          expect(feed.timelines.posts, 'to have length', 1);
          expect(feed.timelines.posts[0], 'to equal', postLunaToMars.id);
        });
      });
    });
  });

  describe("#user's timelines", () => {
    let luna, mars, venus;
    let postCreatedByMars, postCommentedByMars, postLikedByMars;
    beforeEach(async () => {
      [luna, mars, venus] = await Promise.all([
        createUserAsync('luna', 'pw'),
        createUserAsync('mars', 'pw'),
        createUserAsync('venus', 'pw'),
      ]);
      await subscribeToAsync(venus, mars);
      postCreatedByMars = await justCreatePost(mars, 'Post');
      postCommentedByMars = await justCreatePost(venus, 'Post');
      postLikedByMars = await justCreatePost(venus, 'Post');
      await justCreateComment(mars, postCommentedByMars.id, 'Comment');
      await like(postLikedByMars.id, mars.authToken);
      await hidePost(postCreatedByMars.id, luna);
    });

    const nonEmptyExpected =
      (anonymous = true) =>
      async () => {
        const viewer = anonymous ? null : luna;

        {
          const feed = await fetchUserTimeline('Posts', mars, viewer);
          expect(feed.timelines.posts, 'to have length', 1);
          expect(feed.timelines.posts[0], 'to equal', postCreatedByMars.id);
          expect(feed.timelines.subscribers, 'to be non-empty');
          expect(feed.timelines.subscribers, 'to contain', venus.user.id);
        }

        {
          const feed = await fetchUserTimeline('Comments', mars, viewer);
          expect(feed.timelines.posts, 'to have length', 1);
          expect(feed.timelines.posts[0], 'to equal', postCommentedByMars.id);
        }

        {
          const feed = await fetchUserTimeline('Likes', mars, viewer);
          expect(feed.timelines.posts, 'to have length', 1);
          expect(feed.timelines.posts[0], 'to equal', postLikedByMars.id);
        }
      };

    const emptyExpected =
      (anonymous = true) =>
      async () => {
        const viewer = anonymous ? null : luna;

        {
          const feed = await fetchUserTimeline('Posts', mars, viewer);
          expect(feed.timelines.posts, 'to be empty');
          expect(feed.timelines.subscribers, 'to be empty');
        }

        {
          const feed = await fetchUserTimeline('Comments', mars, viewer);
          expect(feed.timelines.posts, 'to be empty');
        }

        {
          const feed = await fetchUserTimeline('Likes', mars, viewer);
          expect(feed.timelines.posts, 'to be empty');
        }
      };

    describe('Mars is a public user', () => {
      it('should return Mars timelines with posts to anonymous', nonEmptyExpected());
      it('should return Mars timelines with posts to Luna', nonEmptyExpected(false));
      it('should return Mars timeline with post having isHidden property', async () => {
        const feed = await fetchUserTimeline('Posts', mars, luna);
        expect(feed.posts[0], 'to have key', 'isHidden');
      });
    });

    describe('Mars is a private user', () => {
      beforeEach(async () => {
        await goPrivate(mars);
      });
      it('should return Mars timelines without posts to anonymous', emptyExpected());
      it('should return Mars timelines without posts to Luna', emptyExpected(false));
    });

    describe('Mars is a protected user', () => {
      beforeEach(async () => {
        await goProtected(mars);
      });
      it('should return Mars timelines without posts to anonymous', emptyExpected());
      it('should return Mars timelines with posts to Luna', nonEmptyExpected(false));
    });

    describe('Mars is a private user and Luna subscribed to him', () => {
      beforeEach(async () => {
        await goPrivate(mars);
        await sendRequestToSubscribe(luna, mars);
        await acceptRequestToSubscribe(luna, mars);
      });
      it('should return Mars timelines with posts to Luna', nonEmptyExpected(false));
    });

    describe('Mars is a public user but bans Luna', () => {
      beforeEach(async () => {
        await banUser(mars, luna);
      });
      it('should return Mars timelines without posts to Luna', emptyExpected(false));
    });

    describe('Mars is a public user but was banned by Luna', () => {
      beforeEach(async () => {
        await banUser(luna, mars);
      });
      it('should return Mars timelines without posts to Luna', emptyExpected(false));
    });
  });

  describe("#user's timelines sorting", () => {
    let luna;
    let post1, post2;
    beforeEach(async () => {
      luna = await createUserAsync('luna', 'pw');
      post1 = await justCreatePost(luna, 'Post');
      post2 = await justCreatePost(luna, 'Post');
    });

    it('should return uncommented Luna posts in creation order', async () => {
      const feed = await fetchUserTimeline('Posts', luna);
      expect(feed.timelines.posts, 'to have length', 2);
      expect(feed.timelines.posts[0], 'to equal', post2.id);
      expect(feed.timelines.posts[1], 'to equal', post1.id);
    });

    it('should return commented Luna posts in bump order', async () => {
      await createCommentAsync(luna, post1.id, 'Comment');
      const feed = await fetchUserTimeline('Posts', luna);
      expect(feed.timelines.posts, 'to have length', 2);
      expect(feed.timelines.posts[0], 'to equal', post1.id);
      expect(feed.timelines.posts[1], 'to equal', post2.id);
    });
  });

  describe('#pagination', () => {
    let luna;
    beforeEach(async () => {
      luna = await createUserAsync('luna', 'pw');
      // Luna creates 10 posts
      await Promise.all([...new Array(10)].map(() => justCreatePost(luna, 'Post')));
    });

    it('should return first page with isLastPage = false', async () => {
      const timeline = await fetchTimeline('luna?limit=5&offset=0');
      expect(timeline.isLastPage, 'to equal', false);
    });

    it('should return last page with isLastPage = true', async () => {
      const timeline = await fetchTimeline('luna?limit=5&offset=5');
      expect(timeline.isLastPage, 'to equal', true);
    });

    it('should return the only page with isLastPage = true', async () => {
      const timeline = await fetchTimeline('luna?limit=15&offset=0');
      expect(timeline.isLastPage, 'to equal', true);
    });
  });

  describe("#user's timelines filter by date", () => {
    let luna;
    let post1, post2, post3;
    beforeEach(async () => {
      luna = await createUserAsync('luna', 'pw');
      post1 = await justCreatePost(luna, 'Post');
      post2 = await justCreatePost(luna, 'Post');
      post3 = await justCreatePost(luna, 'Post');
      await dbAdapter
        .database('posts')
        .where('uid', post1.id)
        .update({ created_at: '2017-05-01T09:00:00Z' });
      await dbAdapter
        .database('posts')
        .where('uid', post2.id)
        .update({ created_at: '2017-05-02T09:00:00Z' });
      await dbAdapter
        .database('posts')
        .where('uid', post3.id)
        .update({ created_at: '2017-05-03T09:00:00Z' });
    });

    it('should return posts created before date', async () => {
      const feed = await fetchTimeline('luna?created-before=2017-05-03T00:00:00Z');
      expect(feed.timelines.posts, 'to have length', 2);
      expect(feed.timelines.posts[0], 'to equal', post2.id);
      expect(feed.timelines.posts[1], 'to equal', post1.id);
    });

    it('should return posts created after date', async () => {
      const feed = await fetchTimeline('luna?created-after=2017-05-02T00:00:00Z');
      expect(feed.timelines.posts, 'to have length', 2);
      expect(feed.timelines.posts[0], 'to equal', post3.id);
      expect(feed.timelines.posts[1], 'to equal', post2.id);
    });

    it('should return posts created before and after date', async () => {
      const feed = await fetchTimeline(
        'luna?created-before=2017-05-03T00:00:00Z&created-after=2017-05-02T00:00:00Z',
      );
      expect(feed.timelines.posts, 'to have length', 1);
      expect(feed.timelines.posts[0], 'to equal', post2.id);
    });
  });

  describe('#saves', () => {
    let luna, mars;
    let post1, post2;
    beforeEach(async () => {
      [luna, mars] = await createTestUsers(2);
      post1 = await justCreatePost(luna, 'Post');
      post2 = await justCreatePost(mars, 'Post');
    });

    it('should not return Saves timeline to anonymous', async () => {
      const response = await fetch(`${app.context.config.host}/v2/timelines/filter/saves`);
      expect(response, 'to satisfy', { status: 401 });
    });

    it('should return correct Saves timeline without posts', async () => {
      const feed = await fetchSaved(luna);
      const savesFeed = await dbAdapter.getUserNamedFeed(luna.user.id, 'Saves');
      expect(feed.timelines, 'to satisfy', {
        id: savesFeed.id,
        name: savesFeed.name,
        posts: [],
      });
    });

    it('should return Saves timeline with one saved post', async () => {
      await savePost(post1.id, luna);
      const feed = await fetchSaved(luna);
      expect(feed.timelines.posts, 'to have length', 1);
      expect(feed.timelines.posts[0], 'to equal', post1.id);
    });

    it('should return empty Saves timeline after unsave', async () => {
      await savePost(post1.id, luna);
      await unsavePost(post1.id, luna);
      const feed = await fetchSaved(luna);
      expect(feed.timelines.posts, 'to be empty');
    });

    it('should return Saves timeline with two saved posts', async () => {
      await savePost(post1.id, luna);
      await savePost(post2.id, luna);
      const feed = await fetchSaved(luna);
      expect(feed.timelines.posts, 'to equal', [post2.id, post1.id]);
    });

    it('should remove post from Saves timeline if it become unavailable', async () => {
      await savePost(post1.id, luna);
      await savePost(post2.id, luna);
      await goPrivate(mars);
      const feed = await fetchSaved(luna);
      expect(feed.timelines.posts, 'to equal', [post1.id]);
    });
  });
});

const fetchHomefeed = (viewerContext, mode = HOMEFEED_MODE_CLASSIC) =>
  fetchTimeline(`home?homefeed-mode=${mode}`, viewerContext);
const fetchMyDiscussions = _.partial(fetchTimeline, 'filter/discussions');
const fetchMyDiscussionsWithMyPosts = _.partial(
  fetchTimeline,
  'filter/discussions?with-my-posts=yes',
);
const fetchDirects = _.partial(fetchTimeline, 'filter/directs');
const fetchSaved = _.partial(fetchTimeline, 'filter/saves');

const fetchUserTimeline = (name, userContext, viewerContext = null) => {
  let path = userContext.username;

  if (name === 'Comments') {
    path = `${path}/comments`;
  }

  if (name === 'Likes') {
    path = `${path}/likes`;
  }

  return fetchTimeline(path, viewerContext);
};
