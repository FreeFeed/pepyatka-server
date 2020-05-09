import compose from 'koa-compose';
import { pick } from 'lodash';

import { authRequired, monitored, inputSchemaRequired } from '../../middlewares';
import { serializeTimeline } from '../../../serializers/v2/timeline';
import { serializeUsersByIds } from '../../../serializers/v2/user';
import { ValidationException, NotFoundException, ForbiddenException } from '../../../support/exceptions'
import { dbAdapter } from '../../../models';

import {
  createHomeFeedInputSchema,
  updateHomeFeedInputSchema,
  deleteHomeFeedInputSchema,
  reorderHomeFeedsInputSchema,
  updateHomeFeedSubscriptionsInputSchema,
} from './data-schemes/homefeeds';


export const listHomeFeeds = compose([
  authRequired(),
  async (ctx) => {
    const { state: { user } } = ctx;

    const homeFeeds = await user.getHomeFeeds();
    const timelines = homeFeeds.map((t) => serializeTimeline(t));
    const users = await serializeUsersByIds([user.id]);

    ctx.body = { timelines, users };
  },
]);

export const createHomeFeed = compose([
  authRequired(),
  inputSchemaRequired(createHomeFeedInputSchema),
  monitored('homefeeds.create'),
  async (ctx) => {
    const { state: { user }, request: { body } } = ctx;

    const title = body.title.trim();

    if (title === '') {
      throw new ValidationException(`Feed title cannot be empty`);
    }

    const feed = await user.createHomeFeed(body.title);

    const users = await serializeUsersByIds([user.id]);
    ctx.body = { timeline: serializeTimeline(feed), users };
  },
]);

export const updateHomeFeed = compose([
  authRequired(),
  inputSchemaRequired(updateHomeFeedInputSchema),
  monitored('homefeeds.update'),
  async (ctx) => {
    const { state: { user }, request: { body } } = ctx;

    const feed = await dbAdapter.getTimelineById(ctx.params.feedId);

    if (!feed || feed.userId !== user.id || feed.name !== 'RiverOfNews') {
      throw new NotFoundException(`Home feed is not found`);
    }

    if (feed.isInherent) {
      throw new NotFoundException(`This inherent feed cannot be updated`);
    }

    const ok = await feed.update({ title: body.title });

    if (!ok) {
      throw new NotFoundException(`Home feed is not found`);
    }

    const users = await serializeUsersByIds([user.id]);
    ctx.body = { timeline: serializeTimeline(feed), users };
  },
]);

export const deleteHomeFeed = compose([
  authRequired(),
  inputSchemaRequired(deleteHomeFeedInputSchema),
  monitored('homefeeds.delete'),
  async (ctx) => {
    const { state: { user }, request: { body } } = ctx;

    const feed = await dbAdapter.getTimelineById(ctx.params.feedId);

    if (!feed || feed.userId !== user.id || feed.name !== 'RiverOfNews') {
      throw new NotFoundException(`Home feed is not found`);
    }

    if (feed.isInherent) {
      throw new ForbiddenException(`This inherent feed cannot be removed`);
    }

    const ok = await feed.destroy({ backupFeedId: body.backupFeed });

    if (!ok) {
      throw new NotFoundException(`Home feed is not found`);
    }

    ctx.body = {};
  },
]);

export const reorderHomeFeeds = compose([
  authRequired(),
  inputSchemaRequired(reorderHomeFeedsInputSchema),
  monitored('homefeeds.reorder'),
  async (ctx) => {
    const { state: { user }, request: { body } } = ctx;

    const feeds = await dbAdapter.getTimelinesByIds(body.reorder);

    if (
      feeds.length === 0 ||
      feeds.some((f) => f.userId !== user.id || f.name !== 'RiverOfNews')
    ) {
      throw new ForbiddenException(`These feeds cannot be reordered`);
    }

    await dbAdapter.reorderFeeds(feeds.map((f) => f.id));

    await listHomeFeeds(ctx);
  },
]);

export const listSubscriptions = compose([
  authRequired(),
  monitored('homefeeds.list-subscriptions'),
  async (ctx) => {
    const { state: { user } } = ctx;

    const [subs, homeFeeds] = await Promise.all([
      user.getSubscriptionsWithHomeFeeds(),
      user.getHomeFeeds(),
    ]);

    const timelines = homeFeeds.map((t) => serializeTimeline(t));
    const usersInHomeFeeds = subs.map((s) => ({ id: s.user_id, homeFeeds: s.homefeed_ids }));
    const users = await serializeUsersByIds([user.id, ...usersInHomeFeeds.map((s) => s.id)],
      true, user.id);

    ctx.body = {
      usersInHomeFeeds,
      timelines,
      users,
    };
  },
]);

export const updateHomeFeedSubscriptions = compose([
  authRequired(),
  inputSchemaRequired(updateHomeFeedSubscriptionsInputSchema),
  monitored('homefeeds.update-subscriptions'),
  async (ctx) => {
    const { state: { user }, request: { body } } = ctx;

    const feed = await dbAdapter.getTimelineById(ctx.params.feedId);

    if (!feed || feed.userId !== user.id || feed.name !== 'RiverOfNews') {
      throw new NotFoundException(`Home feed is not found`);
    }

    await feed.updateHomeFeedSubscriptions(pick(body, ['addUsers', 'removeUsers']));

    const subscribedTo = await feed.getHomeFeedSubscriptions();
    const users = await serializeUsersByIds(subscribedTo, true, user.id);

    ctx.body = {
      subscribedTo,
      users,
    };
  },
]);
