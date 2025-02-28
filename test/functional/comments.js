/* eslint-env node, mocha */
/* global $pg_database */
import request from 'superagent';
import expect from 'unexpected';

import cleanDB from '../dbCleaner';
import { getSingleton } from '../../app/app';
import { DummyPublisher } from '../../app/pubsub';
import { Comment, PubSub } from '../../app/models';

import * as funcTestHelper from './functional_test_helper';
import { getCommentResponse } from './schemaV2-helper';
import { banUser } from './functional_test_helper';

describe('CommentsController', () => {
  let app;

  before(async () => {
    app = await getSingleton();
    PubSub.setPublisher(new DummyPublisher());
  });

  beforeEach(() => cleanDB($pg_database));

  describe('#create()', () => {
    let context = {};
    beforeEach(async () => {
      context = await funcTestHelper.createUserAsync('Luna', 'password');
      context.post = await funcTestHelper.justCreatePost(context, 'Post body');
    });

    describe('in a group', () => {
      const groupName = 'pepyatka-dev';

      beforeEach(async () => {
        const screenName = 'Pepyatka Developers';
        await funcTestHelper.createGroupAsync(context, groupName, screenName);
      });

      it("should not update group's last activity", (done) => {
        const body = 'Post body';

        request
          .post(`${app.context.config.host}/v1/posts`)
          .send({ post: { body }, meta: { feeds: [groupName] }, authToken: context.authToken })
          .end((err, res) => {
            res.status.should.eql(200);
            const postB = res.body.posts;
            funcTestHelper.getTimeline(`/v1/users/${groupName}`, context.authToken, (err, res) => {
              res.status.should.eql(200);
              const lastUpdatedAt = parseInt(res.body.users.updatedAt, 10);

              funcTestHelper.createComment(body, postB.id, context.authToken, (err, res) => {
                res.status.should.eql(200);
                funcTestHelper.getTimeline(
                  `/v1/users/${groupName}`,
                  context.authToken,
                  (err, res) => {
                    res.status.should.eql(200);
                    res.body.should.have.property('users');
                    res.body.users.should.have.property('updatedAt');
                    lastUpdatedAt.should.be.lt(parseInt(res.body.users.updatedAt, 10));

                    done();
                  },
                );
              });
            });
          });
      });
    });

    it('should create a comment with a valid user', (done) => {
      const body = 'Comment';

      funcTestHelper.createCommentCtx(
        context,
        body,
      )((err, res) => {
        res.body.should.not.be.empty;
        res.body.should.have.property('comments');
        res.body.comments.should.have.property('body');
        res.body.comments.body.should.eql(body);

        done();
      });
    });

    it('should not create a comment for an invalid user', (done) => {
      const body = 'Comment';

      context.authToken = 'token';
      funcTestHelper.createCommentCtx(
        context,
        body,
      )((err) => {
        err.should.not.be.empty;
        err.status.should.eql(401);

        done();
      });
    });

    it('should not create a comment for an invalid post', (done) => {
      const body = 'Comment';

      context.post.id = '00000000-0000-4000-8000-000000000046';
      funcTestHelper.createCommentCtx(
        context,
        body,
      )((err) => {
        err.should.not.be.empty;
        err.status.should.eql(404);

        done();
      });
    });

    it('should create a comment to own post even when comments disabled', async () => {
      const postResponse = await funcTestHelper.createPostWithCommentsDisabled(
        context,
        'Post body',
        true,
      );
      const data = await postResponse.json();
      const post = data.posts;

      const response = await funcTestHelper.createCommentAsync(context, post.id, 'Comment');
      response.status.should.eql(200);
    });

    it("should not create a comment to another user's post when comments disabled", async () => {
      const postResponse = await funcTestHelper.createPostWithCommentsDisabled(
        context,
        'Post body',
        true,
      );
      const postData = await postResponse.json();
      const post = postData.posts;

      const marsContext = await funcTestHelper.createUserAsync('mars', 'password2');

      const response = await funcTestHelper.createCommentAsync(marsContext, post.id, 'Comment');
      response.status.should.eql(403);

      const data = await response.json();
      data.should.have.property('err');
      data.err.should.eql('Comments disabled');
    });

    describe('Interaction with banned user', () => {
      let mars;
      let postOfMars;

      beforeEach(async () => {
        mars = await funcTestHelper.createUserAsync('Mars', 'password');
        postOfMars = await funcTestHelper.justCreatePost(mars, 'I am mars!');
        await funcTestHelper.banUser(context, mars);
      });

      it(`should not create comment on banned user's post`, async () => {
        const response = await funcTestHelper.createCommentAsync(context, postOfMars.id, 'Comment');
        response.status.should.eql(403);
      });

      it(`should not create comment on post of user who banned us`, async () => {
        const response = await funcTestHelper.createCommentAsync(mars, context.post.id, 'Comment');
        response.status.should.eql(403);
      });
    });
  });

  describe('#update()', () => {
    let lunaContext = {};
    let yoleContext = {};
    let comment;

    beforeEach(async () => {
      [lunaContext, yoleContext] = await Promise.all([
        funcTestHelper.createUserAsync('Luna', 'password'),
        funcTestHelper.createUserAsync('yole', 'pw'),
      ]);

      const post = await funcTestHelper.justCreatePost(lunaContext, 'post body');
      comment = await funcTestHelper.justCreateComment(lunaContext, post.id, 'comment');
    });

    it('should update a comment with a valid user', (done) => {
      const newBody = 'New body';
      request
        .post(`${app.context.config.host}/v1/comments/${comment.id}`)
        .send({
          comment: { body: newBody },
          authToken: lunaContext.authToken,
          _method: 'put',
        })
        .end((err, res) => {
          res.body.should.not.be.empty;
          res.body.should.have.property('comments');
          res.body.comments.should.have.property('body');
          res.body.comments.body.should.eql(newBody);

          done();
        });
    });

    it('should not update a comment with a invalid user', (done) => {
      const newBody = 'New body';
      request
        .post(`${app.context.config.host}/v1/comments/${comment.id}`)
        .send({
          comment: { body: newBody },
          _method: 'put',
        })
        .end((err) => {
          err.should.not.be.empty;
          err.status.should.eql(401);

          done();
        });
    });

    it("should not update another user's comment", (done) => {
      const newBody = 'New body';
      request
        .post(`${app.context.config.host}/v1/comments/${comment.id}`)
        .send({
          comment: { body: newBody },
          authToken: yoleContext.authToken,
          _method: 'put',
        })
        .end((err) => {
          err.status.should.eql(403);
          done();
        });
    });
  });

  describe('#destroy()', () => {
    let lunaContext = {},
      marsContext = {},
      ceresContext = {};

    let lunaPostLunaComment,
      lunaPostMarsComment,
      marsPostMarsComment,
      marsPostLunaComment,
      marsPostCeresComment;

    beforeEach(async () => {
      [lunaContext, marsContext, ceresContext] = await Promise.all([
        funcTestHelper.createUserAsync('luna', 'password'),
        funcTestHelper.createUserAsync('mars', 'password2'),
        funcTestHelper.createUserAsync('ceres', 'password3'),
      ]);

      const [lunaPost, marsPost] = await Promise.all([
        funcTestHelper.justCreatePost(lunaContext, 'Post body 1'),
        funcTestHelper.justCreatePost(marsContext, 'Post body 2'),
      ]);

      ({ id: lunaPostLunaComment } = await funcTestHelper.justCreateComment(
        lunaContext,
        lunaPost.id,
        'Comment 1-1',
      ));

      ({ id: lunaPostMarsComment } = await funcTestHelper.justCreateComment(
        marsContext,
        lunaPost.id,
        'Comment 1-2',
      ));

      ({ id: marsPostMarsComment } = await funcTestHelper.justCreateComment(
        marsContext,
        marsPost.id,
        'Comment 2-1',
      ));

      ({ id: marsPostLunaComment } = await funcTestHelper.justCreateComment(
        lunaContext,
        marsPost.id,
        'Comment 2-2',
      ));

      ({ id: marsPostCeresComment } = await funcTestHelper.justCreateComment(
        ceresContext,
        marsPost.id,
        'Comment 2-3',
      ));
    });

    it('should remove comment (your own comment in your own post)', async () => {
      const response = await funcTestHelper.removeCommentAsync(lunaContext, lunaPostLunaComment);
      response.status.should.eql(200);
    });

    it("should remove comment (other's comment in your own post)", async () => {
      const response = await funcTestHelper.removeCommentAsync(lunaContext, lunaPostMarsComment);
      response.status.should.eql(200);
    });

    it("should remove comment (your own comment in other's post)", async () => {
      const response = await funcTestHelper.removeCommentAsync(lunaContext, marsPostLunaComment);
      response.status.should.eql(200);
    });

    it("should not remove comment (other's comment in other's post)", async () => {
      const response = await funcTestHelper.removeCommentAsync(lunaContext, marsPostMarsComment);
      response.status.should.eql(403);

      const data = await response.json();
      data.should.have.property('err');
      data.err.should.eql("You don't have permission to delete this comment");
    });

    it("should not remove comment (other's comment in other's post, again)", async () => {
      const response = await funcTestHelper.removeCommentAsync(lunaContext, marsPostCeresComment);
      response.status.should.eql(403);

      const data = await response.json();
      data.should.have.property('err');
      data.err.should.eql("You don't have permission to delete this comment");
    });

    it('should not remove comment if anonymous', async () => {
      const response = await funcTestHelper.removeCommentAsync({}, lunaPostLunaComment);
      response.status.should.eql(401);
    });
  });

  describe('get by id or number', () => {
    let luna, mars, venus, postId, commentIds;
    beforeEach(async () => {
      [luna, mars, venus] = await funcTestHelper.createTestUsers(['luna', 'mars', 'venus']);
      ({ id: postId } = await funcTestHelper.justCreatePost(luna, 'post'));
      commentIds = [];

      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        const data = await funcTestHelper.justCreateComment(
          [luna, mars, luna][i],
          postId,
          `Comment ${i + 1}`,
        );
        commentIds.push(data.id);
      }
    });

    describe('comment by id', () => {
      it('should not return comment by invalid id', async () => {
        const resp = await funcTestHelper.performJSONRequest('GET', `/v1/comments/${postId}`);
        expect(resp.__httpCode, 'to be', 404);
      });

      it('should return public comment by id to anonymous', async () => {
        const resp = await funcTestHelper.performJSONRequest(
          'GET',
          `/v1/comments/${commentIds[0]}`,
        );
        expect(resp, 'to satisfy', getCommentResponse);
        expect(resp, 'to satisfy', {
          __httpCode: 200,
          comments: { id: commentIds[0] },
        });
      });

      describe('Luna became private', () => {
        beforeEach(() => funcTestHelper.goPrivate(luna));

        it('should not return comment by id to anonymous', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v1/comments/${commentIds[0]}`,
          );
          expect(resp.__httpCode, 'to be', 403);
        });

        it('should not return comment by id to Mars', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v1/comments/${commentIds[0]}`,
            undefined,
            funcTestHelper.authHeaders(mars),
          );
          expect(resp.__httpCode, 'to be', 403);
        });

        it('should return comment by id to Luna', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v1/comments/${commentIds[0]}`,
            undefined,
            funcTestHelper.authHeaders(luna),
          );
          expect(resp.__httpCode, 'to be', 200);
        });
      });

      describe('Luna bans Mars', () => {
        beforeEach(() => funcTestHelper.banUser(luna, mars));

        it('should return comment by id to anonymous', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v1/comments/${commentIds[0]}`,
          );
          expect(resp.__httpCode, 'to be', 200);
        });

        it('should not return comment by id to Mars', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v1/comments/${commentIds[0]}`,
            undefined,
            funcTestHelper.authHeaders(mars),
          );
          expect(resp.__httpCode, 'to be', 403);
        });

        it('should return comment by id to Luna', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v1/comments/${commentIds[0]}`,
            undefined,
            funcTestHelper.authHeaders(luna),
          );
          expect(resp.__httpCode, 'to be', 200);
        });
      });

      describe('Venus bans Mars', () => {
        beforeEach(() => funcTestHelper.banUser(venus, mars));

        it('should return hidden Marses comment by id to Venus', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v1/comments/${commentIds[1]}`,
            undefined,
            funcTestHelper.authHeaders(venus),
          );
          expect(resp, 'to satisfy', {
            __httpCode: 200,
            comments: {
              id: commentIds[1],
              body: Comment.hiddenBody(Comment.HIDDEN_AUTHOR_BANNED),
              hideType: Comment.HIDDEN_AUTHOR_BANNED,
              createdBy: null,
            },
          });
        });
      });
    });

    describe('comment by number', () => {
      it('should not return comment by invalid post id', async () => {
        const resp = await funcTestHelper.performJSONRequest(
          'GET',
          `/v2/posts/${commentIds[0]}/comments/1`,
        );
        expect(resp.__httpCode, 'to be', 404);
      });

      it('should not return comment by invalid comment number', async () => {
        const resp = await funcTestHelper.performJSONRequest(
          'GET',
          `/v2/posts/${postId}/comments/137`,
        );
        expect(resp.__httpCode, 'to be', 404);
      });

      it('should return public comment by id to anonymous', async () => {
        const resp = await funcTestHelper.performJSONRequest(
          'GET',
          `/v2/posts/${postId}/comments/1`,
        );
        expect(resp, 'to satisfy', getCommentResponse);
        expect(resp, 'to satisfy', {
          __httpCode: 200,
          comments: { id: commentIds[0] },
        });
      });

      describe('Luna became private', () => {
        beforeEach(() => funcTestHelper.goPrivate(luna));

        it('should not return comment by id to anonymous', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v2/posts/${postId}/comments/1`,
          );
          expect(resp.__httpCode, 'to be', 403);
        });

        it('should not return comment by id to Mars', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v2/posts/${postId}/comments/1`,
            undefined,
            funcTestHelper.authHeaders(mars),
          );
          expect(resp.__httpCode, 'to be', 403);
        });

        it('should return comment by id to Luna', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v2/posts/${postId}/comments/1`,
            undefined,
            funcTestHelper.authHeaders(luna),
          );
          expect(resp.__httpCode, 'to be', 200);
        });
      });

      describe('Luna bans Mars', () => {
        beforeEach(() => funcTestHelper.banUser(luna, mars));

        it('should return comment by id to anonymous', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v2/posts/${postId}/comments/1`,
          );
          expect(resp.__httpCode, 'to be', 200);
        });

        it('should not return comment by id to Mars', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v2/posts/${postId}/comments/1`,
            undefined,
            funcTestHelper.authHeaders(mars),
          );
          expect(resp.__httpCode, 'to be', 403);
        });

        it('should return comment by id to Luna', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v2/posts/${postId}/comments/1`,
            undefined,
            funcTestHelper.authHeaders(luna),
          );
          expect(resp.__httpCode, 'to be', 200);
        });
      });

      describe('Venus bans Mars', () => {
        beforeEach(() => funcTestHelper.banUser(venus, mars));

        it('should return hidden Marses comment by id to Venus', async () => {
          const resp = await funcTestHelper.performJSONRequest(
            'GET',
            `/v2/posts/${postId}/comments/2`,
            undefined,
            funcTestHelper.authHeaders(venus),
          );
          expect(resp, 'to satisfy', {
            __httpCode: 200,
            comments: {
              id: commentIds[1],
              body: Comment.hiddenBody(Comment.HIDDEN_AUTHOR_BANNED),
              hideType: Comment.HIDDEN_AUTHOR_BANNED,
              createdBy: null,
            },
          });
        });
      });
    });
  });

  describe('Comments by ids', () => {
    const nComments = 10;
    let luna, mars, venus, comments;
    beforeEach(async () => {
      [luna, mars, venus] = await funcTestHelper.createTestUsers(['luna', 'mars', 'venus']);
      const post = await funcTestHelper.justCreatePost(venus, 'Post body');

      comments = [];

      for (let n = 0; n < nComments; n++) {
        comments.push(
          // eslint-disable-next-line no-await-in-loop
          await funcTestHelper.justCreateComment(n % 2 == 0 ? luna : mars, post.id, 'Comment'),
        );
      }

      comments.reverse();
    });

    it('should return several comments by ids', async () => {
      const commentIds = comments.slice(0, 3).map((c) => c.id);
      const resp = await funcTestHelper.performJSONRequest('POST', '/v2/comments/byIds', {
        commentIds,
      });
      expect(resp, 'to satisfy', {
        comments: commentIds.map((id) => ({ id })),
      });
    });

    it('should return only existing comments by ids', async () => {
      const commentIds = comments.map((p) => p.id);
      commentIds.push('00000000-0000-4000-8000-000000000001');
      commentIds.push('00000000-0000-4000-8000-000000000002');
      commentIds.push('00000000-0000-4000-8000-000000000003');
      const resp = await funcTestHelper.performJSONRequest('POST', '/v2/comments/byIds', {
        commentIds,
      });
      expect(resp, 'to satisfy', {
        comments: commentIds.slice(0, -3).map((id) => ({ id })),
        commentsNotFound: [
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000003',
        ],
      });
    });

    describe('Luna bans Mars', () => {
      beforeEach(() => banUser(luna, mars));

      it(`should return Marses comments as hidden for Luna`, async () => {
        const commentIds = comments.map((p) => p.id);
        const resp = await funcTestHelper.performJSONRequest(
          'POST',
          '/v2/comments/byIds',
          {
            commentIds,
          },
          funcTestHelper.authHeaders(luna),
        );
        expect(resp, 'to satisfy', {
          comments: commentIds.map((id, i) => ({ id, hideType: i % 2 === 1 ? 0 : 2 })),
        });
      });
    });
  });
});
