import compose from 'koa-compose';
import monitor from 'monitor-dog';
import { difference, uniq } from 'lodash';

import { dbAdapter, Comment, AppTokenV1 } from '../../../models';
import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '../../../support/exceptions';
import {
  serializeComment,
  serializeCommentFull,
  serializeCommentsFull,
} from '../../../serializers/v2/comment';
import {
  authRequired,
  inputSchemaRequired,
  postAccessRequired,
  monitored,
} from '../../middlewares';

import { commentCreateInputSchema, commentUpdateInputSchema } from './data-schemes';
import { getCommentsByIdsInputSchema } from './data-schemes/comments';

export const create = compose([
  authRequired(),
  inputSchemaRequired(commentCreateInputSchema),
  async (ctx, next) => {
    // for the postAccessRequired check
    ctx.params.postId = ctx.request.body.comment.postId;
    await next();
  },
  postAccessRequired(),
  monitored('comments.create'),
  async (ctx) => {
    const { user: author, post } = ctx.state;
    const {
      comment: { body, postId },
    } = ctx.request.body;

    if (post.commentsDisabled === '1' && !(await post.isAuthorOrGroupAdmin(author))) {
      throw new ForbiddenException('Comments disabled');
    }

    const comment = new Comment({ body, postId, userId: author.id });

    try {
      await comment.create();
    } catch (e) {
      throw new BadRequestException(`Can not create comment: ${e.message}`);
    }

    AppTokenV1.addLogPayload(ctx, { commentId: comment.id });
    ctx.body = await serializeComment(comment, author.id);
  },
]);

export const update = compose([
  authRequired(),
  inputSchemaRequired(commentUpdateInputSchema),
  monitored('comments.update'),
  async (ctx) => {
    const { user } = ctx.state;
    const { commentId } = ctx.params;

    const comment = await dbAdapter.getCommentById(commentId);

    if (!comment) {
      throw new NotFoundException('Can not find comment');
    }

    const post = await dbAdapter.getPostById(comment.postId);

    if (!post) {
      // Should not be possible
      throw new NotFoundException('Post not found');
    }

    const isPostVisible = await post.isVisibleFor(user);

    if (!isPostVisible) {
      throw new ForbiddenException('You can not see this post');
    }

    if (comment.userId !== user.id) {
      throw new ForbiddenException("You can't update another user's comment");
    }

    try {
      await comment.update({ body: ctx.request.body.comment.body });
    } catch (e) {
      throw new BadRequestException(`Can not update comment: ${e.message}`);
    }

    ctx.body = await serializeComment(comment, user.id);
  },
]);

export const destroy = compose([
  authRequired(),
  monitored('comments.destroy'),
  async (ctx) => {
    const { user } = ctx.state;
    const { commentId } = ctx.params;

    const comment = await dbAdapter.getCommentById(commentId);

    if (!comment) {
      throw new NotFoundException('Can not find comment');
    }

    const post = await dbAdapter.getPostById(comment.postId);

    if (!post) {
      // Should not be possible
      throw new NotFoundException('Post not found');
    }

    const isPostVisible = await post.isVisibleFor(user);

    if (!isPostVisible) {
      throw new ForbiddenException('You can not see this post');
    }

    if (!comment.canBeDestroyed()) {
      throw new ForbiddenException('You can not destroy a deleted comment');
    }

    if (comment.userId !== user.id && !(await post.isAuthorOrGroupAdmin(user))) {
      throw new ForbiddenException("You don't have permission to delete this comment");
    }

    await comment.destroy(user);
    monitor.increment('comments.destroys');

    ctx.body = {};
  },
]);

export async function getById(ctx) {
  const { user } = ctx.state;
  const { commentId } = ctx.params;

  const comment = await dbAdapter.getCommentById(commentId);

  if (!comment) {
    throw new NotFoundException('Comment not found');
  }

  const post = await dbAdapter.getPostById(comment.postId);

  if (!post) {
    // Should not be possible
    throw new NotFoundException('Comment not found');
  }

  const isPostVisible = await post.isVisibleFor(user);

  if (!isPostVisible) {
    throw new ForbiddenException('You can not see this comment');
  }

  ctx.body = await serializeCommentFull(comment, user?.id);
}

const maxCommentsByIds = 100;

export const getByIds = compose([
  inputSchemaRequired(getCommentsByIdsInputSchema),
  monitored('comments.by-ids'),
  async (ctx) => {
    const { user: viewer } = ctx.state;
    const { commentIds } = ctx.request.body;

    const hasMore = commentIds.length > maxCommentsByIds;

    if (hasMore) {
      commentIds.length = maxCommentsByIds;
    }

    const allComments = await dbAdapter.getCommentsByIds(commentIds);
    const postIds = uniq(allComments.map((c) => c.postId));

    const visiblePostIds = await dbAdapter.selectPostsVisibleByUser(postIds, viewer?.id);
    const visibleComments = allComments.filter((c) => visiblePostIds.includes(c.postId));
    const commentsNotFound = difference(
      commentIds,
      visibleComments.map((c) => c.id),
    );

    ctx.body = await serializeCommentsFull(visibleComments, viewer?.id);
    ctx.body.commentsNotFound = commentsNotFound;
  },
]);

export async function getBySeqNumber(ctx) {
  const { postId, seqNumber } = ctx.params;

  const number = Number.parseInt(seqNumber, 10);
  const comment = await dbAdapter.getCommentBySeqNumber(
    postId,
    Number.isFinite(number) ? number : -1,
  );

  if (!comment) {
    throw new NotFoundException('Comment not found');
  }

  ctx.params.commentId = comment.id;

  await getById(ctx);
}
