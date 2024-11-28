import config from 'config';
import _ from 'lodash';
import validator from 'validator';
import { DateTime, Duration } from 'luxon';
import { camelizeKeys } from 'humps';

import { User, Group, Comment } from '../../models';
import { normalizeEmail } from '../email-norm';
import { List } from '../open-lists';
import { MAX_DATE } from '../constants';

import { initObject, prepareModelPayload } from './utils';

/**
 * @typedef {import('../types').UUID} UUID
 * @typedef {import('../types').ISO8601DateTimeString} ISO8601DateTimeString
 * @typedef {import('../types').ISO8601DurationString} ISO8601DurationString
 */

const usersTrait = (superClass) =>
  class extends superClass {
    async createUser(payload) {
      const preparedPayload = prepareModelPayload(payload, USER_COLUMNS, USER_COLUMNS_MAPPING);

      if (preparedPayload.email) {
        preparedPayload.email_norm = normalizeEmail(preparedPayload.email);
      }

      const [row] = await this.database('users').returning('*').insert(preparedPayload);
      await this.createUserStats(row.uid);
      return initUserObject(row);
    }

    async updateUser(userId, payload) {
      const preparedPayload = prepareModelPayload(payload, USER_COLUMNS, USER_COLUMNS_MAPPING);

      if ('reset_password_token' in preparedPayload) {
        const { tokenTTL } = config.passwordReset;
        preparedPayload['reset_password_sent_at'] = this.database.raw(`now()`);
        preparedPayload['reset_password_expires_at'] = this.database.raw(
          `now() + :tokenTTL * '1 second'::interval`,
          { tokenTTL },
        );
      }

      if (preparedPayload.email) {
        preparedPayload.email_norm = normalizeEmail(preparedPayload.email);
      }

      await this.database('users').where('uid', userId).update(preparedPayload);
      await this.cacheFlushUser(userId);
    }

    async setUserGoneStatus(userId, goneStatus) {
      const goneAt = goneStatus === null ? null : this.database.raw('now()');
      await this.database.raw(
        `update users set
          gone_status = :goneStatus,
          gone_at = :goneAt,
          updated_at = now()
        where uid = :userId`,
        { userId, goneStatus, goneAt },
      );
      await this.cacheFlushUser(userId);
    }

    /**
     * Update username of user or group
     *
     * @param {string} userId
     * @param {string} newUsername
     * @param {string} graceInterval in PostgreSQL interval syntax
     */
    async updateUsername(userId, newUsername, graceInterval = '1 hour') {
      await this.database.transaction(async (trx) => {
        // Lock users table to prevent any updates
        await trx.raw('lock table users in share row exclusive mode');

        const {
          rows: [{ username: currentUsername }],
        } = await trx.raw(`select username from users where uid = :userId`, { userId });

        if (currentUsername === newUsername) {
          return;
        }

        const {
          rows: [{ exists }],
        } = await trx.raw(
          `
        select exists(select 1 from users where username = :newUsername)
          or exists(select 1 from user_past_names where user_id <> :userId and username = :newUsername)
          as exists
        `,
          { userId, newUsername },
        );

        if (exists) {
          throw new Error(`Another user has username '${newUsername}' or had it in the past`);
        }

        /**
         * If the last user_past_names entry's valid_till is younger than graceInterval
         * then _do not record the currentUsername_ and just extend the last entry to the current time.
         * Otherwise insert currentUsername to user_past_names.
         */
        const {
          rows: [lastEntry],
        } = await trx.raw(
          `select id, username, (valid_till > now() - :graceInterval::interval) as new
          from user_past_names where user_id = :userId order by valid_till desc limit 1`,
          { userId, graceInterval },
        );

        if (lastEntry && lastEntry.new) {
          // It is possible that the newUsername is the same as in lastEntry
          // (user just quickly rolled rename back). In this case remove last entry.
          if (lastEntry.username === newUsername) {
            await trx.raw(`delete from user_past_names where id = :id`, { id: lastEntry.id });
          } else {
            await trx.raw(`update user_past_names set valid_till = default where id = :id`, {
              id: lastEntry.id,
            });
          }
        } else {
          await trx.raw(
            `insert into user_past_names (user_id, username) values (:userId, :currentUsername)`,
            { userId, currentUsername },
          );
        }

        await trx.raw(`update users set username = :newUsername where uid = :userId`, {
          userId,
          newUsername,
        });
      });
      await this.cacheFlushUser(userId);
    }

    async getPastUsernames(userId) {
      const { rows } = await this.database.raw(
        `select username, valid_till from user_past_names where user_id = :userId order by valid_till desc`,
        { userId },
      );
      return rows.map((r) => ({ username: r.username, validTill: r.valid_till }));
    }

    setUpdatedAtInGroupsByIds = async (groupIds, time = null) => {
      if (groupIds.length === 0) {
        return;
      }

      let updatedAt = 'now';

      if (time) {
        const t = new Date();
        t.setTime(time);
        updatedAt = t.toISOString();
      }

      const { rows } = await this.database.raw(
        `update users set updated_at = :updatedAt where uid = any(:groupIds) and type = 'group' returning uid`,
        { groupIds, updatedAt },
      );

      await Promise.all(rows.map((row) => this.cacheFlushUser(row.uid)));
    };

    async existsUser(userId) {
      const res = await this.database('users').where('uid', userId).count();
      return parseInt(res[0].count);
    }

    async existsUsername(username) {
      const res = await this.database('users').where('username', username).count();
      return parseInt(res[0].count);
    }

    existsEmail(email) {
      return this.database.getOne(
        `select exists(select 1 from users where lower(email) = lower(:email))`,
        { email },
      );
    }

    existsNormEmail(email) {
      const normEmail = normalizeEmail(email);
      return this.database.getOne(
        `select exists(select 1 from users where email_norm = :normEmail)`,
        { normEmail },
      );
    }

    async getUserById(id) {
      const user = await this.getFeedOwnerById(id);

      if (!user) {
        return null;
      }

      if (!(user instanceof User)) {
        throw new Error(`Expected User, got ${user.constructor.name}`);
      }

      return user;
    }

    async getUsersByIds(userIds) {
      const users = await this.getFeedOwnersByIds(userIds);

      _.each(users, (user) => {
        if (!(user instanceof User)) {
          throw new Error(`Expected User, got ${user.constructor.name}`);
        }
      });

      return users;
    }

    async getUserByUsername(username) {
      const feed = await this.getFeedOwnerByUsername(username);

      if (null === feed) {
        return null;
      }

      if (!(feed instanceof User)) {
        throw new Error(`Expected User, got ${feed.constructor.name}`);
      }

      return feed;
    }

    async getUserByResetToken(token) {
      const attrs = await this.database.getRow(
        `select * from users where reset_password_token = :token and reset_password_expires_at > now()`,
        { token },
      );

      if (!attrs) {
        return null;
      }

      if (attrs.type !== 'user') {
        throw new Error(`Expected User, got ${attrs.type}`);
      }

      return initUserObject(attrs);
    }

    async getUserByEmail(email) {
      const attrs = await this.database('users').first().whereRaw('LOWER(email)=LOWER(?)', email);

      if (!attrs) {
        return null;
      }

      if (attrs.type !== 'user') {
        throw new Error(`Expected User, got ${attrs.type}`);
      }

      return initUserObject(attrs);
    }

    async getUsersByNormEmail(email) {
      const normEmail = normalizeEmail(email);
      const rows = await this.database.getAll(`select * from users where email_norm = :normEmail`, {
        normEmail,
      });

      return rows.map(initUserObject);
    }

    async _getUserIntIdByUUID(userUUID) {
      if (!validator.isUUID(userUUID)) {
        return null;
      }

      const res = await this.database('users').returning('id').first().where('uid', userUUID);

      if (!res) {
        return null;
      }

      return res.id;
    }

    async getFeedOwnerById(id) {
      if (!validator.isUUID(id)) {
        return null;
      }

      return initUserObject(await this.fetchUser(id));
    }

    async getFeedOwnersByIds(ids) {
      return (await this.fetchUsers(ids)).map(initUserObject);
    }

    async getUsersByIdsAssoc(ids) {
      return _.mapValues(await this.fetchUsersAssoc(ids), initUserObject);
    }

    getUsersIdsByIntIds(intIds) {
      return this.database('users').select('id', 'uid').whereIn('id', intIds);
    }

    async getUserByIntId(intId) {
      const row = await this.database.getRow(`select * from users where id = :intId`, { intId });
      return initUserObject(row);
    }

    async getFeedOwnerByUsername(username) {
      let attrs = await this.database('users').first().where('username', username.toLowerCase());

      if (!attrs) {
        const { rows } = await this.database.raw(
          `select u.*
          from users u join user_past_names p on u.uid = p.user_id 
          where p.username = lower(:username) limit 1`,
          { username },
        );

        if (rows.length > 0) {
          [attrs] = rows;
        }
      }

      return initUserObject(attrs);
    }

    async getFeedOwnersByUsernames(usernames) {
      if (usernames.length === 0) {
        return [];
      }

      usernames = usernames.map((u) => u.toLowerCase());
      const users = await this.database('users').whereIn('username', usernames);

      const foundUsernames = users.map((u) => u.username);
      const notFoundUsernames = _.difference(usernames, foundUsernames);

      if (notFoundUsernames.length > 0) {
        const { rows } = await this.database.raw(
          `select distinct u.*
          from users u join user_past_names p on u.uid = p.user_id 
          where p.username = any(:usernames)`,
          { usernames: notFoundUsernames },
        );
        users.push(...rows);
      }

      return _.uniqBy(users, 'id').map(initUserObject);
    }

    async getGroupById(id) {
      const user = await this.getFeedOwnerById(id);

      if (!user) {
        return null;
      }

      if (!(user instanceof Group)) {
        throw new Error(`Expected Group, got ${user.constructor.name}`);
      }

      return user;
    }

    async getGroupByUsername(username) {
      const feed = await this.getFeedOwnerByUsername(username);

      if (null === feed) {
        return null;
      }

      if (!(feed instanceof Group)) {
        throw new Error(`Expected Group, got ${feed.constructor.name}`);
      }

      return feed;
    }

    async getUserSubscribersIds(userId) {
      const feedId = await this.getUserNamedFeedId(userId, 'Posts');
      return await this.getTimelineSubscribersIds(feedId);
    }

    // Insert record to 'archives' table for the test purposes.
    // 'params' should hold optional 'archives' fields.
    async setUserArchiveParams(userId, oldUsername, params = {}) {
      return await this.database('archives').insert({
        ...params,
        user_id: userId,
        old_username: oldUsername,
      });
    }

    // Return data from 'archives' table for the 'whoami' response
    async getUserArchiveParams(userId) {
      const params = await this.database('archives')
        .first(
          'old_username',
          'has_archive',
          'via_sources',
          'recovery_status',
          'restore_comments_and_likes',
        )
        .where({ user_id: userId });

      if (!params) {
        return null;
      }

      params.hidden_comments_count = 0;

      if (!params.restore_comments_and_likes) {
        const sql = `select count(*) from
        hidden_comments h
        join comments c on c.uid = h.comment_id
        where c.hide_type = :hideType and (h.user_id = :userId or h.old_username = :oldUsername)`;
        const res = await this.database.raw(sql, {
          hideType: Comment.HIDDEN_ARCHIVED,
          userId,
          oldUsername: params.old_username,
        });
        params.hidden_comments_count = parseInt(res.rows[0].count);
      }

      return params;
    }

    async startArchiveRestoration(userId, params = {}) {
      params = {
        disable_comments: false,
        via_restore: [],
        ...params,
        recovery_status: 1,
      };
      await this.database('archives').where('user_id', userId).update(params);
    }

    async enableArchivedActivitiesRestoration(userId) {
      await this.database('archives')
        .where('user_id', userId)
        .update({ restore_comments_and_likes: true });
    }

    async someUsersArePublic(userIds, anonymousFriendly) {
      if (userIds.length === 0) {
        return false;
      }

      const { rows } = await this.database.raw(
        `select 1 from users
      where
        not is_private
        and not (:anonymousFriendly and is_protected)
        and uid = any(:userIds)
      limit 1
      `,
        { userIds, anonymousFriendly },
      );
      return rows.length > 0;
    }

    /**
     * Returns List of UIDs of users who cah see any of the given feeds. Only
     * 'Posts' or 'Directs' feeds are counts.
     *
     * @param {number[]} feedIntIds
     * @return {List<UUID>}
     */
    async getUsersWhoCanSeeFeeds(feedIntIds) {
      const hasNotPrivate = await this.database.getOne(
        `select exists (
          select 1 
          from feeds f join users u on u.uid = f.user_id
          where f.name = 'Posts' and f.id = any(:feedIntIds) and not u.is_private
          )`,
        { feedIntIds },
      );

      if (hasNotPrivate) {
        return List.everything();
      }

      return await this.database.getCol(
        `
      -- Feed owners always can see these feeds
      select user_id from feeds where id = any(:feedIntIds) and (name = 'Posts' or name = 'Directs')
      union
      -- Users who subscribed to feeds
      select s.user_id from
        subscriptions s
        join feeds f on f.uid = s.feed_id
      where f.id = any(:feedIntIds) and (f.name = 'Posts' or f.name = 'Directs')
      `,
        { feedIntIds },
      );
    }

    async getNotificationsDigestRecipients() {
      const users = await this.database('users')
        .where('type', 'user')
        .whereRaw(`preferences -> 'sendNotificationsDigest' = 'true'::jsonb`);
      return users.map(initUserObject);
    }

    async getDailyBestOfDigestRecipients() {
      const users = await this.database('users')
        .where('type', 'user')
        .whereRaw(`preferences -> 'sendDailyBestOfDigest' = 'true'::jsonb`);
      return users.map(initUserObject);
    }

    async getWeeklyBestOfDigestRecipients() {
      const users = await this.database('users')
        .where('type', 'user')
        .whereRaw(`preferences -> 'sendWeeklyBestOfDigest' = 'true'::jsonb`);
      return users.map(initUserObject);
    }

    async deleteUser(uid) {
      await this.database('users').where({ uid }).delete();
      await this.cacheFlushUser(uid);
    }

    /**
     *
     * @param {UUID[]} userIds
     * @returns {Promise<Map<UUID, string>>}
     */
    async getDirectModesMap(userIds) {
      const map = new Map();

      if (userIds.length === 0) {
        return map;
      }

      const rows = await this.database.getAll(
        `select uid, preferences -> 'acceptDirectsFrom' as mode
          from users where uid = any(:userIds)`,
        { userIds },
      );

      const defaultMode = config.userPreferences.defaults.acceptDirectsFrom;

      for (const { uid, mode } of rows) {
        map.set(uid, mode ?? defaultMode);
      }

      return map;
    }

    /**
     * @param {UUID} userId
     * @param {ISO8601DateTimeString | ISO8601DurationString | "Infinity"} freezeTime
     * @returns {Promise<void>}
     */
    async freezeUser(userId, freezeTime) {
      let expiresAt;

      if (freezeTime === 'Infinity') {
        expiresAt = freezeTime;
      } else if (freezeTime.startsWith('P')) {
        // Duration
        const d = Duration.fromISO(freezeTime);

        if (!d.isValid) {
          throw new Error(`Invalid duration string: "${freezeTime}"`);
        }

        expiresAt = this.database.raw(`now() + ?`, freezeTime);
      } else {
        // Time as ISO time string
        const d = DateTime.fromISO(freezeTime, { zone: config.ianaTimeZone });

        if (!d.isValid) {
          throw new Error(`Invalid datetime string: "${freezeTime}"`);
        }

        expiresAt = DateTime.fromISO(freezeTime, { zone: config.ianaTimeZone }).toJSDate();
      }

      await this.database.raw(
        `insert into frozen_users (user_id, expires_at) values (:userId, :expiresAt)
        on conflict (user_id) do update set expires_at = excluded.expires_at`,
        { userId, expiresAt },
      );
    }

    /**
     * @param {UUID} userId
     * @returns {Promise<boolean>}
     */
    async isUserFrozen(userId) {
      return (await this.userFrozenUntil(userId)) !== null;
    }

    /**
     * @param {UUID} userId
     * @returns {Promise<string|null>}
     */
    async userFrozenUntil(userId) {
      return (await this.usersFrozenUntil([userId]))[0];
    }

    /**
     * @param {UUID[]} userId
     * @returns {Promise<(string|null)[]>}
     */
    async usersFrozenUntil(userIds) {
      const exps = await this.database.getCol(
        `select f.expires_at 
          from
            unnest(:userIds::uuid[]) with ordinality as src (uid, ord)
            left join frozen_users f on f.user_id = src.uid and f.expires_at > now()
          order by src.ord
          `,
        { userIds },
      );

      return exps.map((exp) => {
        if (!exp || exp instanceof Date) {
          return exp ?? null;
        }

        return MAX_DATE;
      });
    }

    async cleanFrozenUsers() {
      await this.database.raw(`delete from frozen_users where expires_at < now()`);
    }

    getFrozenUsers(limit = 30, offset = 0) {
      return this.database
        .getAll(
          `select * from frozen_users 
          where expires_at > now()
          order by expires_at asc
          limit :limit offset :offset`,
          { limit, offset },
        )
        .then((rows) => camelizeKeys(rows));
    }

    async getUserSysPrefs(userId, key, defaultValue) {
      const v = await this.database.getOne(
        `select jsonb_extract_path(sys_preferences, :key)::text from users where uid = :userId`,
        { key, userId },
      );
      return v !== null ? JSON.parse(v) : defaultValue;
    }

    async setUserSysPrefs(userId, key, value) {
      await this.database.raw(
        `update users 
          set sys_preferences = jsonb_set(coalesce(sys_preferences, '{}'::jsonb), :path, :value)
          where uid = :userId`,
        { path: [key], value: JSON.stringify(value), userId },
      );
    }

    getAllUsersIds(limit = 30, offset = 0, types = ['user']) {
      return this.database.getCol(
        `select uid from users 
          where type = any(:types)
          order by
              created_at desc,
              id desc
          limit :limit offset :offset`,
        { limit, offset, types },
      );
    }

    sparseMatchesUserIds(query) {
      query = query.toLowerCase();
      return this.database.getCol(
        `select uid from users where username like :sparseQuery and not is_private or username = :query`,
        { sparseQuery: `%${query.split('').join('%')}%`, query },
      );
    }
  };

export default usersTrait;

///////////////////////////////////////////////////

export function initUserObject(attrs) {
  if (!attrs) {
    return null;
  }

  attrs = prepareModelPayload(attrs, USER_FIELDS, USER_FIELDS_MAPPING);
  return initObject(attrs.type === 'group' ? Group : User, attrs, attrs.id);
}

const USER_COLUMNS = {
  username: 'username',
  screenName: 'screen_name',
  email: 'email',
  description: 'description',
  type: 'type',
  profilePictureUuid: 'profile_picture_uuid',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  directsReadAt: 'directs_read_at',
  isPrivate: 'is_private',
  isProtected: 'is_protected',
  isRestricted: 'is_restricted',
  hashedPassword: 'hashed_password',
  resetPasswordToken: 'reset_password_token',
  resetPasswordSentAt: 'reset_password_sent_at',
  resetPasswordExpiresAt: 'reset_password_expires_at',
  frontendPreferences: 'frontend_preferences',
  preferences: 'preferences',
  invitationId: 'invitation_id',
};

const USER_COLUMNS_MAPPING = {
  username: (username) => {
    return username.toLowerCase();
  },
  createdAt: (timestamp) => {
    const d = new Date();
    d.setTime(timestamp);
    return d.toISOString();
  },
  updatedAt: (timestamp) => {
    const d = new Date();
    d.setTime(timestamp);
    return d.toISOString();
  },
  directsReadAt: (timestamp) => {
    const d = new Date();
    d.setTime(timestamp);
    return d.toISOString();
  },
  isPrivate: (is_private) => {
    return is_private === '1';
  },
  isProtected: (is_protected) => {
    return is_protected === '1';
  },
  isRestricted: (is_restricted) => {
    return is_restricted === '1';
  },
  resetPasswordSentAt: (timestamp) => {
    const d = new Date();
    d.setTime(timestamp);
    return d.toISOString();
  },
};

const USER_FIELDS = {
  id: 'intId',
  uid: 'id',
  username: 'username',
  screen_name: 'screenName',
  email: 'email',
  description: 'description',
  type: 'type',
  profile_picture_uuid: 'profilePictureUuid',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  directs_read_at: 'directsReadAt',
  notifications_read_at: 'notificationsReadAt',
  is_private: 'isPrivate',
  is_protected: 'isProtected',
  is_restricted: 'isRestricted',
  hashed_password: 'hashedPassword',
  reset_password_token: 'resetPasswordToken',
  reset_password_sent_at: 'resetPasswordSentAt',
  reset_password_expires_at: 'resetPasswordExpiresAt',
  frontend_preferences: 'frontendPreferences',
  subscribed_feed_ids: 'subscribedFeedIds',
  private_meta: 'privateMeta',
  preferences: 'preferences',
  gone_status: 'goneStatus',
  gone_at: 'goneAt',
  invitation_id: 'invitationId',
};

const USER_FIELDS_MAPPING = {
  created_at: (time) => {
    return time.getTime().toString();
  },
  updated_at: (time) => {
    return time.getTime().toString();
  },
  is_private: (is_private) => {
    return is_private ? '1' : '0';
  },
  is_protected: (is_protected) => {
    return is_protected ? '1' : '0';
  },
  is_restricted: (is_restricted) => {
    return is_restricted ? '1' : '0';
  },
  reset_password_sent_at: (time) => {
    return time && time.getTime();
  },
  reset_password_expires_at: (time) => {
    return time && time.getTime();
  },
  private_meta: (data) => data || {},
};
