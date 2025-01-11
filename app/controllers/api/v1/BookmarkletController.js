import compose from 'koa-compose';

import { Post, Comment, AppTokenV1, Attachment } from '../../../models';
import { ForbiddenException } from '../../../support/exceptions';
import { authRequired, monitored, inputSchemaRequired } from '../../middlewares';
import { show as showPost } from '../v2/PostsController';
import { downloadURL } from '../../../support/download-url';

import { bookmarkletCreateInputSchema } from './data-schemes';
import { getDestinationFeeds } from './PostsController';

export const create = compose([
  authRequired(),
  inputSchemaRequired(bookmarkletCreateInputSchema),
  monitored('bookmarklet.create'),
  async (ctx) => {
    const { user: author } = ctx.state;
    const {
      meta: { feeds },
      title: body,
      comment: commentBody,
      images,
      image,
    } = ctx.request.body;

    const destNames = typeof feeds === 'string' ? [feeds] : feeds;

    if (destNames.length === 0) {
      destNames.push(author.username);
    }

    const timelines = await getDestinationFeeds(author, destNames, null);

    // Attachments
    if (images.length === 0 && image !== '') {
      // Only use 'image' if 'images' is empty
      images.push(image);
    }

    const attachments = await Promise.all(
      images.map(async (url) => {
        try {
          return await createAttachment(author, url);
        } catch (e) {
          throw new ForbiddenException(`Unable to load URL '${url}': ${e.message}`);
        }
      }),
    );

    const post = new Post({
      userId: author.id,
      body,
      attachments,
      timelineIds: timelines.map((f) => f.id),
    });
    await post.create();

    if (commentBody !== '') {
      const comment = new Comment({
        body: commentBody,
        postId: post.id,
        userId: author.id,
      });
      await comment.create();
    }

    ctx.params.postId = post.id;
    AppTokenV1.addLogPayload(ctx, { postId: post.id });

    await showPost(ctx);
  },
]);

async function createAttachment(author, imageURL) {
  const file = await downloadURL(imageURL);

  try {
    if (!/^image\//.test(file.type)) {
      throw new Error(`Unsupported content type: '${file.type}'`);
    }

    const newAttachment = await Attachment.create(file.path, file.name, author);
    return newAttachment.id;
  } catch (e) {
    await file.unlink();
    throw e;
  }
}
