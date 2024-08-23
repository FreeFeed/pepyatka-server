import _ from 'lodash';
import NodeCache from 'node-cache';
import { ioRedisStore } from '@tirke/node-cache-manager-ioredis';
import config from 'config';
import { createCache, memoryStore } from 'cache-manager';

import { connect as redisConnect } from '../../setup/database';

import usersTrait from './users';
import usersCacheTrait from './users-cache';
import usersStatsTrait from './users-stats';
import subscrRequestsTrait from './subscr-requests';
import bansTrait from './bans';
import groupAdminsTrait from './group-admins';
import attachmentsTrait from './attachments';
import likesTrait from './likes';
import commentsTrait from './comments';
import feedsTrait from './feeds';
import postsTrait from './posts';
import visibilityTrait from './visibility';
import timelinesPostsTrait from './timelines-posts';
import subscriptionsTrait from './subscriptions';
import localBumpsTrait from './local-bumps';
import hashtagsTrait from './hashtags';
import unreadDirectsTrait from './unread-directs';
import statsTrait from './stats';
import eventsTrait from './events';
import commentLikesTrait from './comment-likes';
import allGroupsTrait from './all-groups';
import summaryTrait from './summary';
import calendarTrait from './calendar';
import invitationsTrait from './invitations';
import appTokensTrait from './app-tokens';
import externalAuthTrait from './external-auth';
import serverInfoTrait from './server-info';
import searchTrait from './search';
import { withDbHelpers } from './db-helpers';
import nowTrait from './now';
import jobsTrait from './jobs';
import authSessionsTrait from './auth-sessions';
import backlinksTrait from './backlinks';
import groupBlocksTrait from './group-blocks';
import emailVerificationTrait from './email-verification';
import adminTrait from './admins';
import userStatsDynamicTrait from './user-stats-dynamic';
import translationUsageTrait from './translation-usage';
import postCommentEventsTrait from './post-comment-events';

class DbAdapterBase {
  constructor(database) {
    this.database = withDbHelpers(database);
    this.statsCache = new NodeCache({ stdTTL: 300 });

    const CACHE_TTL = 60 * 60 * 24; // 24 hours

    this.memoryCache = createCache(memoryStore(), {
      max: 5000,
      ttl: CACHE_TTL * 1000 /* milliseconds*/,
    });
    this.cache = createCache(ioRedisStore({ redisInstance: redisConnect() }), { ttl: CACHE_TTL });

    this.searchQueriesTimeout = config.performance.searchQueriesTimeout;
    this._pgVersion = null;
  }

  /**
   * Return PostgreSQL version as number (PG_VERSION_NUM)
   */
  async getPGVersion() {
    if (!this._pgVersion) {
      this._pgVersion = parseInt(await this.database.getOne('show server_version_num'), 10);
    }

    return this._pgVersion;
  }

  doInTransaction(action) {
    if (this._inTransaction) {
      throw new Error(`Nested transactions aren't supported yet`);
    }

    return this.database.transaction(async (tx) => {
      const prevDb = this.database;
      this.database = withDbHelpers(tx);
      this._inTransaction = true;

      try {
        return await action();
      } finally {
        this.database = prevDb;
        this._inTransaction = false;
      }
    });
  }
}

// Extending DbAdapterBase by traits
export const DbAdapter = _.flow([
  usersTrait,
  usersCacheTrait,
  usersStatsTrait,
  subscrRequestsTrait,
  bansTrait,
  groupAdminsTrait,
  attachmentsTrait,
  likesTrait,
  commentsTrait,
  feedsTrait,
  postsTrait,
  visibilityTrait,
  timelinesPostsTrait,
  subscriptionsTrait,
  localBumpsTrait,
  hashtagsTrait,
  unreadDirectsTrait,
  statsTrait,
  eventsTrait,
  commentLikesTrait,
  allGroupsTrait,
  summaryTrait,
  calendarTrait,
  invitationsTrait,
  appTokensTrait,
  externalAuthTrait,
  serverInfoTrait,
  searchTrait,
  nowTrait,
  jobsTrait,
  authSessionsTrait,
  backlinksTrait,
  groupBlocksTrait,
  emailVerificationTrait,
  adminTrait,
  userStatsDynamicTrait,
  translationUsageTrait,
  postCommentEventsTrait,
])(DbAdapterBase);
