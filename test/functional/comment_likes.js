/* eslint-env node, mocha */
/* global $pg_database */

import fetch from 'node-fetch'
import knexCleaner from 'knex-cleaner'
import expect from 'unexpected'
import uuid from 'uuid'
import validator from 'validator'

import { getSingleton } from '../../app/app'
import { DummyPublisher } from '../../app/pubsub'
import { PubSub } from '../../app/models'
import {
  acceptRequestToJoinGroup,
  banUser,
  createAndReturnPost,
  createAndReturnPostToFeed,
  createCommentAsync,
  createGroupAsync,
  createUserAsync,
  mutualSubscriptions,
  sendRequestToJoinGroup,
  updateUserAsync
} from './functional_test_helper'
import * as schema from './schemaV2-helper'


describe('Comment likes', () => {
  let app;
  let likeComment, unlikeComment, writeComment, getLikes;

  before(async () => {
    app = await getSingleton();
    likeComment = createCommentLike(app);
    unlikeComment = deleteCommentLike(app);
    getLikes = getCommentLikes(app);
    writeComment = createComment();
    PubSub.setPublisher(new DummyPublisher());
  });

  beforeEach(async () => {
    await knexCleaner.clean($pg_database);
  });

  describe('CommentLikesController', () => {
    describe('#like', () => {
      it('should reject unauthenticated users', async () => {
        const res = await likeComment(uuid.v4());
        expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'Unauthorized'));
      });

      describe('for authenticated users', () => {
        describe('public users Luna, Mars and stranger Jupiter', () => {
          let luna, mars, jupiter;
          let lunaPost, marsPost;

          beforeEach(async () => {
            [luna, mars, jupiter] = await Promise.all([
              createUserAsync('luna', 'pw'),
              createUserAsync('mars', 'pw'),
              createUserAsync('jupiter', 'pw'),
            ]);
            [lunaPost, marsPost] = await Promise.all([
              createAndReturnPost(luna, 'Luna post'),
              createAndReturnPost(mars, 'Mars post')
            ]);
            await mutualSubscriptions([luna, mars]);
          });

          it('should not allow to like nonexisting comment', async () => {
            const res = await likeComment(uuid.v4(), luna);
            expect(res, 'to exhaustively satisfy', apiErrorExpectation(404, "Can't find comment"));
          });

          it('should not allow to like own comments to own post', async () => {
            const lunaComment = await writeComment(luna, lunaPost.id, 'Luna comment');
            const res = await likeComment(lunaComment.id, luna);
            expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, "You can't like your own comment"));
          });

          it('should not allow to like own comments to other user post', async () => {
            const lunaComment = await writeComment(luna, marsPost.id, 'Luna comment');
            const res = await likeComment(lunaComment.id, luna);
            expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, "You can't like your own comment"));
          });

          it("should allow Luna to like Mars' comment to Luna's post", async () => {
            const marsComment = await writeComment(mars, lunaPost.id, 'Mars comment');
            const res = await likeComment(marsComment.id, luna);
            expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
          });

          it("should allow Luna to like Mars' comment to Mars' post", async () => {
            const marsComment = await writeComment(mars, marsPost.id, 'Mars comment');
            const res = await likeComment(marsComment.id, luna);
            expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
          });

          it("should allow Jupiter to like Mars' comment to Luna's post", async () => {
            const marsComment = await writeComment(mars, lunaPost.id, 'Mars comment');
            const res = await likeComment(marsComment.id, jupiter);
            expect(res, 'to satisfy', commentHavingOneLikeExpectation(jupiter));
          });

          it('should not allow to like comment more than one time', async () => {
            const marsComment = await writeComment(mars, lunaPost.id, 'Mars comment');
            const res1 = await likeComment(marsComment.id, luna);
            expect(res1.status, 'to be', 200);

            const res2 = await likeComment(marsComment.id, luna);
            expect(res2, 'to exhaustively satisfy', apiErrorExpectation(403, "You can't like comment that you have already liked"));
          });

          describe('comment likes sorting', () => {
            let pluto;

            beforeEach(async () => {
              pluto = await createUserAsync('pluto', 'pw');
            });

            it('should sort comment likes chronologically descending (except viewer)', async () => {
              const lunaComment = await writeComment(luna, lunaPost.id, 'Luna comment');
              let res = await likeComment(lunaComment.id, mars);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(mars));
              await likeComment(lunaComment.id, jupiter);
              res = await likeComment(lunaComment.id, pluto);

              expect(res, 'to satisfy', { status: 200 });
              const responseJson = await res.json();

              expect(responseJson, 'to satisfy', {
                likes: expect.it('to be an array').and('to be non-empty').and('to have length', 3),
                users: expect.it('to be an array').and('to have items satisfying', schema.user)
              });

              expect(responseJson.likes[0].userId, 'to be', pluto.user.id);
              expect(responseJson.likes[1].userId, 'to be', jupiter.user.id);
              expect(responseJson.likes[2].userId, 'to be', mars.user.id);
            });
          });

          describe('when Luna bans Mars and stranger Pluto', () => {
            let pluto;
            let plutoPost;

            beforeEach(async () => {
              pluto = await createUserAsync('pluto', 'pw');
              plutoPost = await createAndReturnPost(pluto, 'Pluto post');
              await Promise.all([
                banUser(luna, mars),
                banUser(luna, pluto)
              ]);
            });

            it("should not allow Luna to like Mars' comment to Mars' post", async () => {
              const marsComment = await writeComment(mars, marsPost.id, 'Mars comment');
              const res = await likeComment(marsComment.id, luna);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
            });

            it("should not allow Luna to like Pluto's comment to Pluto's post", async () => {
              const plutoComment = await writeComment(pluto, plutoPost.id, 'Pluto comment');
              const res = await likeComment(plutoComment.id, luna);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
            });

            it("should not allow Luna to like Pluto's comment to Mars' post", async () => {
              const plutoComment = await writeComment(pluto, marsPost.id, 'Pluto comment');
              const res = await likeComment(plutoComment.id, luna);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
            });

            it("should allow Mars to like Luna's comment to Luna's post", async () => {
              const lunaComment = await writeComment(luna, lunaPost.id, 'Luna comment');
              const res = await likeComment(lunaComment.id, mars);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(mars));
            });

            it("should allow Pluto to like Luna's comment to Luna's post", async () => {
              const lunaComment = await writeComment(luna, lunaPost.id, 'Luna comment');
              const res = await likeComment(lunaComment.id, pluto);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(pluto));
            });

            it("should allow Pluto to like Jupiter's comment to Luna's post", async () => {
              const jupiterComment = await writeComment(jupiter, lunaPost.id, 'Jupiter comment');
              const res = await likeComment(jupiterComment.id, pluto);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(pluto));
            });

            it('should not display Luna comment likes of Pluto and Mars', async () => {
              const jupiterPost = await createAndReturnPost(jupiter, 'Jupiter post');
              const jupiterComment = await writeComment(jupiter, jupiterPost.id, 'Jupiter comment');
              let res = await likeComment(jupiterComment.id, pluto);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(pluto));
              await likeComment(jupiterComment.id, mars);
              res = await likeComment(jupiterComment.id, luna);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
            });
          });

          describe('public group Dubhe, public restricted group Merak, private group Phad, private restricted group Alkaid', () => {
            let dubhe, merak, phad, alkaid;
            let dubhePost, merakPost, phadPost, alkaidPost;
            beforeEach(async () => {
              [dubhe, merak, phad, alkaid] = await Promise.all([
                createGroupAsync(luna, 'dubhe',  'Dubhe',  false, false),
                createGroupAsync(luna, 'merak',  'Merak',  false, true),
                createGroupAsync(luna, 'phad',   'Phad',   true,  false),
                createGroupAsync(luna, 'alkaid', 'Alkaid', true,  true),
              ]);

              [dubhePost, merakPost, phadPost, alkaidPost] = await Promise.all([
                createAndReturnPostToFeed(dubhe,  luna, 'Dubhe post'),
                createAndReturnPostToFeed(merak,  luna, 'Merak post'),
                createAndReturnPostToFeed(phad,   luna, 'Phad post'),
                createAndReturnPostToFeed(alkaid, luna, 'Alkaid post')
              ]);
              await sendRequestToJoinGroup(mars, phad);
              await acceptRequestToJoinGroup(luna, mars, phad);
              await sendRequestToJoinGroup(mars, alkaid);
              await acceptRequestToJoinGroup(luna, mars, alkaid);
            });

            it('should allow any user to like comment in a public group', async () => {
              const marsComment = await writeComment(mars, dubhePost.id, 'Mars comment');
              const res = await likeComment(marsComment.id, jupiter);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(jupiter));
            });

            it('should allow any user to like comment in a public restricted group', async () => {
              const marsComment = await writeComment(mars, merakPost.id, 'Mars comment');
              const res = await likeComment(marsComment.id, jupiter);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(jupiter));
            });

            it('should allow members to like comment in a private group', async () => {
              const marsComment = await writeComment(mars, phadPost.id, 'Mars comment');
              const res = await likeComment(marsComment.id, luna);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
            });

            it('should not allow non-members to like comment in a private group', async () => {
              const marsComment = await writeComment(mars, phadPost.id, 'Mars comment');
              const res = await likeComment(marsComment.id, jupiter);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(404, "Can't find post"));
            });

            it('should allow members to like comment in a private restricted group', async () => {
              const marsComment = await writeComment(mars, alkaidPost.id, 'Mars comment');
              const res = await likeComment(marsComment.id, luna);
              expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
            });

            it('should not allow non-members to like comment in a private restricted group', async () => {
              const marsComment = await writeComment(mars, alkaidPost.id, 'Mars comment');
              const res = await likeComment(marsComment.id, jupiter);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(404, "Can't find post"));
            });
          });
        });
      });
    });

    describe('#unlike', () => {
      it('should reject unauthenticated users', async () => {
        const res = await unlikeComment(uuid.v4());
        expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'Unauthorized'));
      });

      describe('for authenticated users', () => {
        describe('public users Luna, Mars and stranger Jupiter', () => {
          let luna, mars, jupiter;
          let lunaPost, marsPost;

          beforeEach(async () => {
            [luna, mars, jupiter] = await Promise.all([
              createUserAsync('luna', 'pw'),
              createUserAsync('mars', 'pw'),
              createUserAsync('jupiter', 'pw'),
            ]);
            [lunaPost, marsPost] = await Promise.all([
              createAndReturnPost(luna, 'Luna post'),
              createAndReturnPost(mars, 'Mars post')
            ]);
            await mutualSubscriptions([luna, mars]);
          });

          it('should not allow to unlike nonexisting comment', async () => {
            const res = await unlikeComment(uuid.v4(), luna);
            expect(res, 'to exhaustively satisfy', apiErrorExpectation(404, "Can't find comment"));
          });

          it('should not allow to unlike own comments to own post', async () => {
            const lunaComment = await writeComment(luna, lunaPost.id, 'Luna comment');
            const res = await unlikeComment(lunaComment.id, luna);
            expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, "You can't un-like your own comment"));
          });

          it('should not allow to unlike own comments to other user post', async () => {
            const lunaComment = await writeComment(luna, marsPost.id, 'Luna comment');
            const res = await unlikeComment(lunaComment.id, luna);
            expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, "You can't un-like your own comment"));
          });

          it("should allow Luna to unlike Mars' comment to Luna's post", async () => {
            const marsComment = await writeComment(mars, lunaPost.id, 'Mars comment');
            await likeComment(marsComment.id, luna);
            const res = await unlikeComment(marsComment.id, luna);
            expect(res, 'to satisfy', commentHavingNoLikesExpectation);
          });

          it("should allow Luna to unlike Mars' comment to Mars' post", async () => {
            const marsComment = await writeComment(mars, marsPost.id, 'Mars comment');
            await likeComment(marsComment.id, luna);
            const res = await unlikeComment(marsComment.id, luna);
            expect(res, 'to satisfy', commentHavingNoLikesExpectation);
          });

          it("should allow Jupiter to unlike Mars' comment to Luna's post", async () => {
            const marsComment = await writeComment(mars, lunaPost.id, 'Mars comment');
            await likeComment(marsComment.id, jupiter);
            const res = await unlikeComment(marsComment.id, jupiter);
            expect(res, 'to satisfy', commentHavingNoLikesExpectation);
          });

          it("should not allow to unlike comment that haven't been liked", async () => {
            const marsComment = await writeComment(mars, lunaPost.id, 'Mars comment');
            const res = await unlikeComment(marsComment.id, luna);
            expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, "You can't un-like comment that you haven't yet liked"));
          });

          it('should not allow to unlike comment more than one time', async () => {
            const marsComment = await writeComment(mars, lunaPost.id, 'Mars comment');
            await likeComment(marsComment.id, luna);
            const res1 = await unlikeComment(marsComment.id, luna);
            expect(res1, 'to satisfy', commentHavingNoLikesExpectation);

            const res2 = await unlikeComment(marsComment.id, luna);
            expect(res2, 'to exhaustively satisfy', apiErrorExpectation(403, "You can't un-like comment that you haven't yet liked"));
          });

          describe('comment likes sorting', () => {
            let pluto;

            beforeEach(async () => {
              pluto = await createUserAsync('pluto', 'pw');
            });

            it('should sort comment likes chronologically descending', async () => {
              const lunaComment = await writeComment(luna, lunaPost.id, 'Luna comment');
              await likeComment(lunaComment.id, mars);
              await likeComment(lunaComment.id, jupiter);
              await likeComment(lunaComment.id, pluto);
              const res = await unlikeComment(lunaComment.id, pluto);

              expect(res, 'to satisfy', { status: 200 });
              const responseJson = await res.json();

              expect(responseJson, 'to satisfy', {
                likes: expect.it('to be an array').and('to be non-empty').and('to have length', 2),
                users: expect.it('to be an array').and('to have items satisfying', schema.user)
              });

              expect(responseJson.likes[0].userId, 'to be', jupiter.user.id);
              expect(responseJson.likes[1].userId, 'to be', mars.user.id);
            });
          });

          describe('when Luna bans Mars and stranger Pluto', () => {
            let pluto;
            let plutoPost;

            beforeEach(async () => {
              pluto = await createUserAsync('pluto', 'pw');
              plutoPost = await createAndReturnPost(pluto, 'Pluto post');
              await Promise.all([
                banUser(luna, mars),
                banUser(luna, pluto)
              ]);
            });

            it("should not allow Luna to unlike Mars' comment to Mars' post", async () => {
              const marsComment = await writeComment(mars, marsPost.id, 'Mars comment');
              const res = await unlikeComment(marsComment.id, luna);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
            });

            it("should not allow Luna to unlike Pluto's comment to Pluto's post", async () => {
              const plutoComment = await writeComment(pluto, plutoPost.id, 'Pluto comment');
              const res = await unlikeComment(plutoComment.id, luna);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
            });

            it("should not allow Luna to unlike Pluto's comment to Mars' post", async () => {
              const plutoComment = await writeComment(pluto, marsPost.id, 'Pluto comment');
              const res = await unlikeComment(plutoComment.id, luna);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
            });

            it("should allow Mars to unlike Luna's comment to Luna's post", async () => {
              const lunaComment = await writeComment(luna, lunaPost.id, 'Luna comment');
              await likeComment(lunaComment.id, mars);
              const res = await unlikeComment(lunaComment.id, mars);
              expect(res, 'to satisfy', commentHavingNoLikesExpectation);
            });

            it("should allow Pluto to unlike Luna's comment to Luna's post", async () => {
              const lunaComment = await writeComment(luna, lunaPost.id, 'Luna comment');
              await likeComment(lunaComment.id, pluto);
              const res = await unlikeComment(lunaComment.id, pluto);
              expect(res, 'to satisfy', commentHavingNoLikesExpectation);
            });

            it("should allow Pluto to unlike Jupiter's comment to Luna's post", async () => {
              const jupiterComment = await writeComment(jupiter, lunaPost.id, 'Jupiter comment');
              await likeComment(jupiterComment.id, pluto);
              const res = await unlikeComment(jupiterComment.id, pluto);
              expect(res, 'to satisfy', commentHavingNoLikesExpectation);
            });

            it('should not display Luna comment likes of Pluto and Mars', async () => {
              const jupiterPost = await createAndReturnPost(jupiter, 'Jupiter post');
              const jupiterComment = await writeComment(jupiter, jupiterPost.id, 'Jupiter comment');
              await likeComment(jupiterComment.id, pluto);
              await likeComment(jupiterComment.id, mars);
              await likeComment(jupiterComment.id, luna);
              const res = await unlikeComment(jupiterComment.id, luna);
              expect(res, 'to satisfy', commentHavingNoLikesExpectation);
            });

            describe('when Luna bans Jupiter after liking his comment', () => {
              it("should not allow Luna to unlike Jupiter's comment to Jupiter's post", async () => {
                const jupiterPost = await createAndReturnPost(jupiter, 'Jupiter post');
                const jupiterComment = await writeComment(jupiter, jupiterPost.id, 'Jupiter comment');
                await likeComment(jupiterComment.id, luna);

                await banUser(luna, jupiter);

                const res = await unlikeComment(jupiterComment.id, luna);
                expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
              });
            });
          });

          describe('public group Dubhe, public restricted group Merak, private group Phad, private restricted group Alkaid', () => {
            let dubhe, merak, phad, alkaid;
            let dubhePost, merakPost, phadPost, alkaidPost;
            beforeEach(async () => {
              [dubhe, merak, phad, alkaid] = await Promise.all([
                createGroupAsync(luna, 'dubhe',  'Dubhe',  false, false),
                createGroupAsync(luna, 'merak',  'Merak',  false, true),
                createGroupAsync(luna, 'phad',   'Phad',   true,  false),
                createGroupAsync(luna, 'alkaid', 'Alkaid', true,  true),
              ]);

              [dubhePost, merakPost, phadPost, alkaidPost] = await Promise.all([
                createAndReturnPostToFeed(dubhe,  luna, 'Dubhe post'),
                createAndReturnPostToFeed(merak,  luna, 'Merak post'),
                createAndReturnPostToFeed(phad,   luna, 'Phad post'),
                createAndReturnPostToFeed(alkaid, luna, 'Alkaid post')
              ]);
              await sendRequestToJoinGroup(mars, phad);
              await acceptRequestToJoinGroup(luna, mars, phad);
              await sendRequestToJoinGroup(mars, alkaid);
              await acceptRequestToJoinGroup(luna, mars, alkaid);
            });

            it('should allow any user to unlike comment in a public group', async () => {
              const marsComment = await writeComment(mars, dubhePost.id, 'Mars comment');
              await likeComment(marsComment.id, jupiter);
              const res = await unlikeComment(marsComment.id, jupiter);
              expect(res, 'to satisfy', commentHavingNoLikesExpectation);
            });

            it('should allow any user to unlike comment in a public restricted group', async () => {
              const marsComment = await writeComment(mars, merakPost.id, 'Mars comment');
              await likeComment(marsComment.id, jupiter);
              const res = await unlikeComment(marsComment.id, jupiter);
              expect(res, 'to satisfy', commentHavingNoLikesExpectation);
            });

            it('should allow members to unlike comment in a private group', async () => {
              const marsComment = await writeComment(mars, phadPost.id, 'Mars comment');
              await likeComment(marsComment.id, luna);
              const res = await unlikeComment(marsComment.id, luna);
              expect(res, 'to satisfy', commentHavingNoLikesExpectation);
            });

            it('should not allow non-members to unlike comment in a private group', async () => {
              const marsComment = await writeComment(mars, phadPost.id, 'Mars comment');
              const res = await unlikeComment(marsComment.id, jupiter);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(404, "Can't find post"));
            });

            it('should allow members to unlike comment in a private restricted group', async () => {
              const marsComment = await writeComment(mars, alkaidPost.id, 'Mars comment');
              await likeComment(marsComment.id, luna);
              const res = await unlikeComment(marsComment.id, luna);
              expect(res, 'to satisfy', commentHavingNoLikesExpectation);
            });

            it('should not allow non-members to unlike comment in a private restricted group', async () => {
              const marsComment = await writeComment(mars, alkaidPost.id, 'Mars comment');
              const res = await unlikeComment(marsComment.id, jupiter);
              expect(res, 'to exhaustively satisfy', apiErrorExpectation(404, "Can't find post"));
            });
          });
        });
      });
    });

    describe('#likes', () => {
      let luna, mars, jupiter;
      let lunaPost, marsPost;
      let marsComment, lunaComment;

      beforeEach(async () => {
        [luna, mars, jupiter] = await Promise.all([
          createUserAsync('luna', 'pw'),
          createUserAsync('mars', 'pw'),
          createUserAsync('jupiter', 'pw'),
        ]);
        [lunaPost, marsPost] = await Promise.all([
          createAndReturnPost(luna, 'Luna post'),
          createAndReturnPost(mars, 'Mars post')
        ]);
        await mutualSubscriptions([luna, mars]);
        marsComment = await writeComment(mars, lunaPost.id, 'Mars comment');
        lunaComment = await writeComment(luna, marsPost.id, 'Luna comment');
        await likeComment(marsComment.id, luna);
      });

      it('should not allow to show likes of nonexisting comment', async () => {
        const res = await getLikes(uuid.v4(), luna);
        expect(res, 'to exhaustively satisfy', apiErrorExpectation(404, "Can't find comment"));
      });

      describe('for unauthenticated users', () => {
        it('should display comment likes for public post', async () => {
          const res = await getLikes(marsComment.id);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
        });

        it("should display no comment likes for public post's comment that has no likes", async () => {
          const res = await getLikes(lunaComment.id);
          expect(res, 'to satisfy', commentHavingNoLikesExpectation);
        });

        it('should not display comment likes for protected post', async () => {
          await updateUserAsync(luna, { isProtected: '1' });
          const res = await getLikes(marsComment.id);
          expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'Please sign in to view this post'));
        });

        it('should not display comment likes for private post', async () => {
          await updateUserAsync(luna, { isProtected: '0', isPrivate: '1' });
          const res = await getLikes(marsComment.id);
          expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You cannot see this post'));
        });
      });

      describe('for authenticated users', () => {
        it('should display comment likes for public post', async () => {
          const res = await getLikes(marsComment.id, luna);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
        });

        it("should display no comment likes for public post's comment that has no likes", async () => {
          const res = await getLikes(lunaComment.id, luna);
          expect(res, 'to satisfy', commentHavingNoLikesExpectation);
        });

        it('should display comment likes for protected post for all users', async () => {
          await updateUserAsync(luna, { isProtected: '1' });
          let res = await getLikes(marsComment.id, luna);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
          res = await getLikes(marsComment.id, mars);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
          res = await getLikes(marsComment.id, jupiter);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
        });

        it('should display comment likes to subscribers of private user', async () => {
          await updateUserAsync(luna, { isProtected: '0', isPrivate: '1' });
          let res = await getLikes(marsComment.id, luna);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
          res = await getLikes(marsComment.id, mars);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
        });

        it('should not display comment likes to non-subscribers of private user', async () => {
          await updateUserAsync(luna, { isProtected: '0', isPrivate: '1' });
          const res = await getLikes(marsComment.id, jupiter);
          expect(res, 'to exhaustively satisfy', apiErrorExpectation(404, "Can't find post"));
        });
      });

      describe('comment likes sorting', () => {
        let pluto;

        beforeEach(async () => {
          pluto = await createUserAsync('pluto', 'pw');
          await likeComment(marsComment.id, jupiter);
          await likeComment(marsComment.id, pluto);
        });

        it('should sort comment likes chronologically descending (except viewer)', async () => {
          const res = await getLikes(marsComment.id, luna);
          expect(res, 'to satisfy', { status: 200 });
          const responseJson = await res.json();

          expect(responseJson, 'to satisfy', {
            likes: expect.it('to be an array').and('to be non-empty').and('to have length', 3),
            users: expect.it('to be an array').and('to have items satisfying', schema.user)
          });

          expect(responseJson.likes[0].userId, 'to be', luna.user.id);
          expect(responseJson.likes[1].userId, 'to be', pluto.user.id);
          expect(responseJson.likes[2].userId, 'to be', jupiter.user.id);
        });

        it('should sort comment likes chronologically descending for authenticated viewer', async () => {
          const res = await getLikes(marsComment.id, mars);
          expect(res, 'to satisfy', { status: 200 });
          const responseJson = await res.json();

          expect(responseJson, 'to satisfy', {
            likes: expect.it('to be an array').and('to be non-empty').and('to have length', 3),
            users: expect.it('to be an array').and('to have items satisfying', schema.user)
          });

          expect(responseJson.likes[0].userId, 'to be', pluto.user.id);
          expect(responseJson.likes[1].userId, 'to be', jupiter.user.id);
          expect(responseJson.likes[2].userId, 'to be', luna.user.id);
        });

        it('should sort comment likes chronologically descending for anonymous viewer', async () => {
          const res = await getLikes(marsComment.id);
          expect(res, 'to satisfy', { status: 200 });
          const responseJson = await res.json();

          expect(responseJson, 'to satisfy', {
            likes: expect.it('to be an array').and('to be non-empty').and('to have length', 3),
            users: expect.it('to be an array').and('to have items satisfying', schema.user)
          });

          expect(responseJson.likes[0].userId, 'to be', pluto.user.id);
          expect(responseJson.likes[1].userId, 'to be', jupiter.user.id);
          expect(responseJson.likes[2].userId, 'to be', luna.user.id);
        });
      });

      describe('when Luna bans Mars and stranger Pluto', () => {
        let pluto, plutoPost, plutoComment, jupiterComment;

        beforeEach(async () => {
          pluto = await createUserAsync('pluto', 'pw');
          plutoPost = await createAndReturnPost(pluto, 'Pluto post');
          plutoComment = await writeComment(pluto, plutoPost.id, 'Pluto comment');
          jupiterComment = await writeComment(jupiter, plutoPost.id, 'Jupiter comment');
          await likeComment(plutoComment.id, jupiter);
          await likeComment(jupiterComment.id, pluto);
          await Promise.all([
            banUser(luna, mars),
            banUser(luna, pluto)
          ]);
        });

        it("should not show Luna Mars' comment likes", async () => {
          const res = await getLikes(marsComment.id, luna);
          expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
        });

        it("should not show Luna Pluto's comment likes", async () => {
          const res = await getLikes(plutoComment.id, luna);
          expect(res, 'to exhaustively satisfy', apiErrorExpectation(403, 'You have banned the author of this comment'));
        });

        it("should not show Luna Pluto's likes to Jupiter's comment", async () => {
          const res = await getLikes(jupiterComment.id, luna);
          expect(res, 'to satisfy', commentHavingNoLikesExpectation);
        });

        it("should show Mars Luna's comment likes", async () => {
          const res = await getLikes(marsComment.id, mars);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
        });

        it("should show Pluto Luna's comment likes", async () => {
          const res = await getLikes(marsComment.id, pluto);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));
        });

        it("should show Pluto Jupiter's comment likes", async () => {
          const res = await getLikes(plutoComment.id, pluto);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(jupiter));
        });

        it('should not display Luna comment likes of Pluto and Mars', async () => {
          const jupiterPost = await createAndReturnPost(jupiter, 'Jupiter post');
          const jupiterComment2 = await writeComment(jupiter, jupiterPost.id, 'Jupiter comment');

          await likeComment(jupiterComment2.id, pluto);
          await likeComment(jupiterComment2.id, mars);
          await likeComment(jupiterComment2.id, luna);

          let res = await getLikes(jupiterComment2.id, luna);
          expect(res, 'to satisfy', commentHavingOneLikeExpectation(luna));

          res = await getLikes(jupiterComment2.id, pluto);
          const responseJson = await res.json();

          expect(responseJson, 'to satisfy', {
            likes: expect.it('to be an array').and('to be non-empty').and('to have length', 3),
            users: expect.it('to be an array').and('to have items satisfying', schema.user)
          });

          expect(responseJson.likes[0].userId, 'to be', pluto.user.id);
          expect(responseJson.likes[1].userId, 'to be', luna.user.id);
          expect(responseJson.likes[2].userId, 'to be', mars.user.id);
        });
      });
    });
  });
});

const createCommentLike = (app) => async (commentId, likerContext = null) => {
  const headers = {} ;
  if (likerContext) {
    headers['X-Authentication-Token'] = likerContext.authToken;
  }
  const response = await fetch(`${app.context.config.host}/v2/comments/${commentId}/like`, { method: 'POST', headers });
  return response;
};

const deleteCommentLike = (app) => async (commentId, unlikerContext = null) => {
  const headers = {} ;
  if (unlikerContext) {
    headers['X-Authentication-Token'] = unlikerContext.authToken;
  }
  const response = await fetch(`${app.context.config.host}/v2/comments/${commentId}/unlike`, { method: 'POST', headers });
  return response;
};

const getCommentLikes = (app) => async (commentId, viewerContext = null) => {
  const headers = {} ;
  if (viewerContext) {
    headers['X-Authentication-Token'] = viewerContext.authToken;
  }
  const response = await fetch(`${app.context.config.host}/v2/comments/${commentId}/likes`, { method: 'GET', headers });
  return response;
};

const createComment = () => async (userContext, postId, body) => {
  const response = await createCommentAsync(userContext, postId, body);
  const commentData = await response.json();
  return commentData.comments;
};

const commentHavingOneLikeExpectation = (liker) => async (obj) => {
  expect(obj, 'to satisfy', { status: 200 });
  const responseJson = await obj.json();

  expect(responseJson, 'to satisfy', {
    likes: expect.it('to be an array')
             .and('to be non-empty')
             .and('to have length', 1)
             .and('to have items satisfying', {
               userId:    expect.it('to satisfy', schema.UUID).and('to be', liker.user.id),
               createdAt: expect.it('when passed as parameter to', validator.isISO8601, 'to be', true)
             }),
    users: expect.it('to be an array').and('to have items satisfying', schema.user)
  });
};

const commentHavingNoLikesExpectation = async (obj) => {
  expect(obj, 'to satisfy', { status: 200 });
  const responseJson = await obj.json();

  expect(responseJson, 'to satisfy', {
    likes: expect.it('to be an array').and('to be empty'),
    users: expect.it('to be an array').and('to be empty')
  });
};

const apiErrorExpectation = (code, message) => async (obj) => {
  expect(obj, 'to satisfy', { status: code });
  const responseJson = await obj.json();
  expect(responseJson, 'to satisfy', { err: message });
};
