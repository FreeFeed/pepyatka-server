import crypto from 'crypto';
import { promises as fs, createReadStream } from 'fs';
import util from 'util';

import bcrypt from 'bcrypt';
import gmLib from 'gm';
import GraphemeBreaker from 'grapheme-breaker';
import _ from 'lodash';
import monitor from 'monitor-dog';
import validator from 'validator';
import { v4 as uuidv4 } from 'uuid';
import config from 'config';

import { s3Client } from '../support/s3';
import { BadRequestException, NotFoundException, ValidationException } from '../support/exceptions';
import { Attachment, Comment, Post, PubSub as pubSub } from '../models';
import { EventService } from '../support/EventService';
import { userCooldownStart, userDataDeletionStart } from '../jobs/user-gone';
import { allExternalProviders } from '../support/ExtAuth';

import { validate as validateUserPrefs } from './user-prefs';

const gm = gmLib.subClass({ imageMagick: true });

const randomBytes = util.promisify(crypto.randomBytes);

// Account is suspended for unknown period
export const GONE_SUSPENDED = 10;
// Account is suspended for cooldown period, the next state is GONE_DELETION
export const GONE_COOLDOWN = 20;
// Cooldown period is over, user data is being deleted, the next state is GONE_DELETED
export const GONE_DELETION = 30;
// User data is fully deleted
export const GONE_DELETED = 40;

export const GONE_NAMES = {
  [GONE_SUSPENDED]: 'SUSPENDED',
  [GONE_COOLDOWN]: 'COOLDOWN',
  [GONE_DELETION]: 'DELETION',
  [GONE_DELETED]: 'DELETED',
};

export function addModel(dbAdapter) {
  return class User {
    static PROFILE_PICTURE_SIZE_LARGE = 75;
    static PROFILE_PICTURE_SIZE_MEDIUM = 50;

    static ACCEPT_DIRECTS_FROM_ALL = 'all';
    static ACCEPT_DIRECTS_FROM_FRIENDS = 'friends';

    static feedNames = [
      'RiverOfNews',
      'Hides',
      'Comments',
      'Likes',
      'Posts',
      'Directs',
      'MyDiscussions',
      'Saves',
    ];

    type = 'user';

    constructor(params) {
      this.goneStatus = params.goneStatus || null;
      this.intId = params.intId;
      this.id = params.id;
      this.username = params.username;
      this.screenName = params.screenName || params.username;
      this.email = params.email;
      // The .hiddenEmail field holds real email address of inactive user (the
      // .email field of such user is always empty)
      this.hiddenEmail = params.email || '';
      this.description = params.description || '';
      this.frontendPreferences = params.frontendPreferences || {};
      this.preferences = validateUserPrefs(params.preferences, true, params.createdAt);

      this.isPrivate = params.isPrivate;
      this.isProtected = this.isPrivate === '1' ? '1' : params.isProtected;

      this.invitationId = params.invitationId || null;

      if (parseInt(params.createdAt, 10)) {
        this.createdAt = params.createdAt;
      }

      if (parseInt(params.updatedAt, 10)) {
        this.updatedAt = params.updatedAt;
      }

      this.goneAt = params.goneAt;

      this.profilePictureUuid = params.profilePictureUuid || '';
      this.subscribedFeedIds = params.subscribedFeedIds || [];
      this.privateMeta = params.privateMeta;
      this.notificationsReadAt = params.notificationsReadAt;

      if (this.isUser()) {
        if (params.hashedPassword !== undefined) {
          this.plaintextPassword = null;
          this.hashedPassword = params.hashedPassword;
        } else {
          this.plaintextPassword = params.password || '';
          this.hashedPassword = null;
        }

        this.resetPasswordToken = params.resetPasswordToken;
        this.resetPasswordSentAt = params.resetPasswordSentAt;
      }

      if (!this.isActive) {
        // 'Anonymize' inactive users
        // Only id's, username and createdAt are visible
        this.screenName = this.username;
        this.email = '';
        this.description = '';
        this.frontendPreferences = {};
        this.preferences = validateUserPrefs({}, true, this.createdAt);
        this.isPrivate = '1';
        this.isProtected = '1';
        this.updatedAt = this.createdAt;
        this.profilePictureUuid = '';
        this.subscribedFeedIds = [];
        this.privateMeta = {};
        this.notificationsReadAt = this.createdAt;
        this.resetPasswordToken = null;
        this.resetPasswordSentAt = null;
      }
    }

    get username() {
      return this.username_;
    }
    set username(newValue) {
      if (newValue) {
        this.username_ = newValue.trim().toLowerCase();
      }
    }

    get screenName() {
      return this.screenName_;
    }
    set screenName(newValue) {
      if (_.isString(newValue)) {
        this.screenName_ = newValue.trim();
      }
    }

    get email() {
      return this.email_ === undefined ? '' : this.email_;
    }
    set email(newValue) {
      if (_.isString(newValue)) {
        this.email_ = newValue.trim();
      }
    }

    get isPrivate() {
      return this.isPrivate_;
    }
    set isPrivate(newValue) {
      this.isPrivate_ = newValue || '0';
    }

    get isProtected() {
      return this.isProtected_;
    }
    set isProtected(newValue) {
      this.isProtected_ = newValue || '0';
    }

    get description() {
      return this.description_;
    }
    set description(newValue) {
      if (_.isString(newValue)) {
        this.description_ = newValue.trim();
      }
    }

    get frontendPreferences() {
      return this.frontendPreferences_;
    }
    set frontendPreferences(newValue) {
      if (_.isString(newValue)) {
        newValue = JSON.parse(newValue);
      }

      this.frontendPreferences_ = newValue;
    }

    /**
     * User.isActive is true for non-disabled users
     */
    get isActive() {
      return this.goneStatus === null;
    }

    /**
     * User.isResumable is true if user is gone but can be resumed
     */
    get isResumable() {
      return [GONE_COOLDOWN].includes(this.goneStatus);
    }

    static stopList(skipExtraList) {
      if (skipExtraList) {
        return config.application.USERNAME_STOP_LIST;
      }

      return config.application.USERNAME_STOP_LIST.concat(config.application.EXTRA_STOP_LIST);
    }

    static getObjectsByIds(objectIds) {
      return dbAdapter.getFeedOwnersByIds(objectIds);
    }

    isUser() {
      return this.type === 'user';
    }
    isGroup() {
      return !this.isUser();
    }

    async newPost(attrs) {
      attrs.userId = this.id;

      if (!attrs.timelineIds || !attrs.timelineIds[0]) {
        const timelineId = await this.getPostsTimelineId();
        attrs.timelineIds = [timelineId];
      }

      return new Post(attrs);
    }

    async updateResetPasswordToken() {
      const token = await this.generateResetPasswordToken();

      const payload = { resetPasswordToken: token };

      await dbAdapter.updateUser(this.id, payload);

      this.resetPasswordToken = token;
      return this.resetPasswordToken;
    }

    async generateResetPasswordToken() {
      const buf = await randomBytes(config.passwordReset.tokenBytesLength);
      return buf.toString('base64').replace(/\W/g, '');
    }

    validPassword(clearPassword) {
      return bcrypt.compare(clearPassword, this.hashedPassword);
    }

    /**
     * @return {Promise<boolean>}
     */
    async isValidEmail() {
      try {
        await User.validateEmail(this.email);
        return true;
      } catch {
        return false;
      }
    }

    static async validateEmail(email) {
      // email is optional
      if (!email || email.length == 0) {
        return;
      }

      if (!validator.isEmail(email)) {
        throw new ValidationException('Invalid email format');
      }

      const exists = await dbAdapter.existsEmail(email);

      if (exists) {
        // email is taken
        throw new ValidationException('This email address is already in use');
      }
    }

    isValidUsername(skip_stoplist) {
      const valid =
        this.username &&
        this.username.length >= 3 && // per the spec
        this.username.length <= 25 && // per the spec
        this.username.match(/^[A-Za-z0-9]+$/) &&
        !User.stopList(skip_stoplist).includes(this.username);

      return valid;
    }

    isValidScreenName() {
      return this.screenNameIsValid(this.screenName);
    }

    screenNameIsValid(screenName) {
      if (typeof screenName !== 'string') {
        return false;
      }

      const len = GraphemeBreaker.countBreaks(screenName.trim());

      if (len < 3 || len > 25) {
        return false;
      }

      return true;
    }

    isValidDescription() {
      return User.descriptionIsValid(this.description);
    }

    static descriptionIsValid(description) {
      const len = GraphemeBreaker.countBreaks(description);
      return len <= config.maxLength.description;
    }

    static frontendPreferencesIsValid(frontendPreferences) {
      // Check size
      const prefString = JSON.stringify(frontendPreferences);
      const len = GraphemeBreaker.countBreaks(prefString);

      if (len > config.frontendPreferencesLimit) {
        return false;
      }

      // Check structure
      // (for each key in preferences there must be an object value)
      if (!_.isPlainObject(frontendPreferences)) {
        return false;
      }

      for (const prop in frontendPreferences) {
        if (!frontendPreferences[prop] || typeof frontendPreferences[prop] !== 'object') {
          return false;
        }
      }

      return true;
    }

    async validate(skip_stoplist) {
      if (!this.isValidUsername(skip_stoplist)) {
        throw new ValidationException('Invalid username');
      }

      if (!this.isValidScreenName()) {
        throw new ValidationException(
          `"${this.screenName}" is not a valid display name. Names must be between 3 and 25 characters long.`,
        );
      }

      await User.validateEmail(this.email);

      if (!this.isValidDescription()) {
        throw new ValidationException('Description is too long');
      }
    }

    async validateUsernameUniqueness() {
      const res = await dbAdapter.existsUsername(this.username);

      if (res !== 0) {
        throw new ValidationException('Already exists');
      }
    }

    async validateOnCreate(skip_stoplist) {
      await Promise.all([this.validate(skip_stoplist), this.validateUsernameUniqueness()]);

      if (this.type === 'user' && this.plaintextPassword !== null) {
        if (this.plaintextPassword.length === 0) {
          throw new ValidationException('Password cannot be blank');
        }

        this.hashedPassword = await bcrypt.hash(this.plaintextPassword, 10);
        this.plaintextPassword = null;
      }
    }

    async create(skip_stoplist) {
      this.screenName = this.screenName || this.username;

      await this.validateOnCreate(skip_stoplist);

      const timer = monitor.timer('users.create-time');

      const payload = {
        username: this.username,
        screenName: this.screenName,
        email: this.email ? this.email : null,
        type: this.type,
        isPrivate: this.isPrivate,
        isProtected: this.isProtected,
        description: '',
        hashedPassword: this.hashedPassword,
        frontendPreferences: JSON.stringify({}),
        preferences: this.preferences,
        invitationId: this.invitationId,
      };

      const newAcc = await dbAdapter.createUser(payload);

      for (const key of ['id', 'intId', 'createdAt', 'updatedAt']) {
        this[key] = newAcc[key];
      }

      await dbAdapter.createUserTimelines(this.id, User.feedNames);
      timer.stop();
      monitor.increment('users.creates');

      return this;
    }

    async update(params) {
      const payload = {};
      const changeableKeys = [
        'screenName',
        'email',
        'isPrivate',
        'isProtected',
        'description',
        'frontendPreferences',
        'preferences',
      ];

      if (params.hasOwnProperty('screenName') && params.screenName != this.screenName) {
        if (!this.screenNameIsValid(params.screenName)) {
          throw new ValidationException(
            `"${params.screenName}" is not a valid display name. Names must be between 3 and 25 characters long.`,
          );
        }

        payload.screenName = params.screenName;
      }

      if (params.hasOwnProperty('email') && params.email != this.email) {
        await User.validateEmail(params.email);
        payload.email = params.email;
      }

      if (params.hasOwnProperty('isPrivate') && params.isPrivate != this.isPrivate) {
        if (params.isPrivate != '0' && params.isPrivate != '1') {
          // ???
          throw new ValidationException('bad input');
        }

        payload.isPrivate = params.isPrivate;
      }

      // Compatibility with pre-isProtected clients:
      // if there is only isPrivate param then isProtected becomes the same as isPrivate
      if (
        params.hasOwnProperty('isPrivate') &&
        (!params.hasOwnProperty('isProtected') || params.isPrivate === '1')
      ) {
        params.isProtected = params.isPrivate;
      }

      if (params.hasOwnProperty('isProtected') && params.isProtected != this.isProtected) {
        payload.isProtected = params.isProtected;
      }

      if (params.hasOwnProperty('description') && params.description != this.description) {
        if (!User.descriptionIsValid(params.description)) {
          throw new ValidationException('Description is too long');
        }

        payload.description = params.description;
      }

      if (params.hasOwnProperty('frontendPreferences')) {
        // Validate the input object
        if (!User.frontendPreferencesIsValid(params.frontendPreferences)) {
          throw new ValidationException('Invalid frontendPreferences');
        }

        const preferences = {
          ...this.frontendPreferences,
          ...params.frontendPreferences,
        };

        // Validate the merged object
        if (!User.frontendPreferencesIsValid(preferences)) {
          throw new ValidationException('Invalid frontendPreferences');
        }

        payload.frontendPreferences = preferences;
      }

      if (params.hasOwnProperty('preferences')) {
        if (!_.isPlainObject(params.preferences)) {
          throw new ValidationException(`Invalid 'preferences': must be a plain object`);
        }

        try {
          payload.preferences = validateUserPrefs(
            {
              ...this.preferences,
              ...params.preferences,
            },
            false,
            this.createdAt,
          );
        } catch (e) {
          throw new ValidationException(`Invalid 'preferences': ${e}`);
        }
      }

      if (_.intersection(Object.keys(payload), changeableKeys).length > 0) {
        const preparedPayload = payload;
        payload.updatedAt = new Date().getTime();

        preparedPayload.updatedAt = payload.updatedAt.toString();

        if (_.has(payload, 'frontendPreferences')) {
          preparedPayload.frontendPreferences = JSON.stringify(payload.frontendPreferences);
        }

        await dbAdapter.updateUser(this.id, preparedPayload);
        await pubSub.globalUserUpdate(this.id);

        for (const k in payload) {
          this[k] = payload[k];
        }
      }

      return this;
    }

    async updateUsername(newUsername) {
      await dbAdapter.updateUsername(this.id, newUsername);
      await pubSub.globalUserUpdate(this.id);
      return this;
    }

    /**
     * This method doesn't update the current object properties
     * @param {number|null} status
     */
    async setGoneStatus(status) {
      await dbAdapter.setUserGoneStatus(this.id, status);
      const modified = await dbAdapter.getFeedOwnerById(this.id);
      this.goneAt = modified.goneAt;
      this.goneStatus = modified.goneStatus;

      if (status === GONE_COOLDOWN) {
        await userCooldownStart(this);
      }

      if (status === GONE_DELETION) {
        await userDataDeletionStart(this);
      }

      await pubSub.globalUserUpdate(this.id);
      const managedGroupIds = await dbAdapter.getManagedGroupIds(this.id);
      // Some managed groups may change their isRestricted status so send update
      // for all of them (just to be safe)
      await Promise.all(managedGroupIds.map((id) => pubSub.globalUserUpdate(id)));
    }

    get goneStatusName() {
      if (this.goneStatus === null) {
        return 'ACTIVE';
      }

      return GONE_NAMES[this.goneStatus] ?? `STATUS_${this.goneStatus}`;
    }

    async getPastUsernames() {
      return await dbAdapter.getPastUsernames(this.id);
    }

    async updatePassword(password, passwordConfirmation) {
      if (password.length === 0) {
        throw new ValidationException('Password cannot be blank');
      }

      if (password !== passwordConfirmation) {
        throw new ValidationException('Passwords do not match');
      }

      const updatedAt = new Date().getTime();
      const payload = {
        updatedAt: updatedAt.toString(),
        hashedPassword: await bcrypt.hash(password, 10),
      };

      await dbAdapter.updateUser(this.id, payload);

      this.updatedAt = updatedAt;
      this.hashedPassword = payload.hashedPassword;

      return this;
    }

    getAdministratorIds() {
      return [this.id];
    }

    getAdministrators() {
      return [this];
    }

    getMyDiscussionsTimeline() {
      return dbAdapter.getUserNamedFeed(this.id, 'MyDiscussions');
    }

    async getGenericTimelineId(name) {
      const timelineId = await dbAdapter.getUserNamedFeedId(this.id, name);

      if (!timelineId) {
        console.log(`Timeline '${name}' not found for user`, this); // eslint-disable-line no-console
        return null;
      }

      return timelineId;
    }

    async getUnreadDirectsNumber() {
      const unreadDirectsNumber = await dbAdapter.getUnreadDirectsNumber(this.id);
      return unreadDirectsNumber;
    }

    async getGenericTimelineIntId(name) {
      const timelineIds = await this.getTimelineIds();
      const intIds = await dbAdapter.getTimelinesIntIdsByUUIDs([timelineIds[name]]);

      if (intIds.length === 0) {
        return null;
      }

      return intIds[0];
    }

    getGenericTimeline(name) {
      return dbAdapter.getUserNamedFeed(this.id, name);
    }

    getMyDiscussionsTimelineIntId() {
      return this.getGenericTimelineIntId('MyDiscussions');
    }

    getHidesTimelineId() {
      return this.getGenericTimelineId('Hides');
    }

    getHidesTimelineIntId(params) {
      return this.getGenericTimelineIntId('Hides', params);
    }

    getSavesTimelineId() {
      return this.getGenericTimelineId('Saves');
    }

    getSavesTimelineIntId(params) {
      return this.getGenericTimelineIntId('Saves', params);
    }

    getRiverOfNewsTimelineId() {
      return this.getGenericTimelineId('RiverOfNews');
    }

    getRiverOfNewsTimelineIntId(params) {
      return this.getGenericTimelineIntId('RiverOfNews', params);
    }

    getRiverOfNewsTimeline() {
      return dbAdapter.getUserNamedFeed(this.id, 'RiverOfNews');
    }

    getLikesTimelineId() {
      return this.getGenericTimelineId('Likes');
    }

    getLikesTimelineIntId() {
      return this.getGenericTimelineIntId('Likes');
    }

    getLikesTimeline(params) {
      return this.getGenericTimeline('Likes', params);
    }

    getPostsTimelineId() {
      return this.getGenericTimelineId('Posts');
    }

    getPostsTimelineIntId() {
      return this.getGenericTimelineIntId('Posts');
    }

    getPostsTimeline(params) {
      return this.getGenericTimeline('Posts', params);
    }

    getCommentsTimelineId() {
      return this.getGenericTimelineId('Comments');
    }

    getCommentsTimelineIntId() {
      return this.getGenericTimelineIntId('Comments');
    }

    getCommentsTimeline(params) {
      return this.getGenericTimeline('Comments', params);
    }

    getDirectsTimelineId() {
      return this.getGenericTimelineId('Directs');
    }

    getDirectsTimeline(params) {
      return this.getGenericTimeline('Directs', params);
    }

    async getTimelineIds() {
      const timelineIds = await dbAdapter.getUserTimelinesIds(this.id);
      return timelineIds || {};
    }

    async getTimelines(params) {
      const timelineIds = await this.getTimelineIds();
      const timelines = await dbAdapter.getTimelinesByIds(Object.values(timelineIds), params);
      return _.sortBy(timelines, (tl) => User.feedNames.indexOf(tl.name));
    }

    getPublicTimelineIds() {
      return Promise.all([
        this.getCommentsTimelineId(),
        this.getLikesTimelineId(),
        this.getPostsTimelineId(),
      ]);
    }

    getPublicTimelinesIntIds() {
      return dbAdapter.getUserNamedFeedsIntIds(this.id, ['Posts', 'Likes', 'Comments']);
    }

    /**
     * @param {string} title
     * @returns {Promise<Timeline>}
     */
    createHomeFeed(title) {
      return dbAdapter.addNamedFeed(this.id, 'RiverOfNews', title);
    }

    /**
     * @returns {Promise<Timeline[]>}
     */
    getHomeFeeds() {
      return dbAdapter.getAllUserNamedFeed(this.id, 'RiverOfNews');
    }

    getSubscriptionsWithHomeFeeds() {
      return dbAdapter.getSubscriptionsWithHomeFeeds(this.id);
    }

    /**
     * @return {Timeline[]}
     */
    async getSubscriptions() {
      this.subscriptions = await dbAdapter.getTimelinesByIntIds(this.subscribedFeedIds);
      return this.subscriptions;
    }

    async getFriendIds() {
      return await dbAdapter.getUserFriendIds(this.id);
    }

    async getFriends() {
      const userIds = await this.getFriendIds();
      return await dbAdapter.getUsersByIds(userIds);
    }

    async getSubscriberIds() {
      const postsFeedIntId = await this.getPostsTimelineIntId();
      const timeline = await dbAdapter.getTimelineByIntId(postsFeedIntId);
      this.subscriberIds = await timeline.getSubscriberIds();

      return this.subscriberIds;
    }

    async getSubscribers() {
      const subscriberIds = await this.getSubscriberIds();
      this.subscribers = await dbAdapter.getUsersByIds(subscriberIds);

      return this.subscribers;
    }

    getBanIds() {
      return dbAdapter.getUserBansIds(this.id);
    }

    async ban(username) {
      const user = await dbAdapter.getUserByUsername(username);

      if (null === user) {
        throw new NotFoundException(`User "${username}" is not found`);
      }

      await dbAdapter.createUserBan(this.id, user.id);

      const promises = [user.unsubscribeFrom(this)];

      // reject if and only if there is a pending request
      const requestIds = await this.getSubscriptionRequestIds();
      let bannedUserHasRequestedSubscription = false;

      if (requestIds.includes(user.id)) {
        bannedUserHasRequestedSubscription = true;
        promises.push(this.rejectSubscriptionRequest(user.id));
      }

      await Promise.all(promises);
      monitor.increment('users.bans');

      await EventService.onUserBanned(this.intId, user.intId, bannedUserHasRequestedSubscription);
      return 1;
    }

    async unban(username) {
      const user = await dbAdapter.getUserByUsername(username);

      if (null === user) {
        throw new NotFoundException(`User "${username}" is not found`);
      }

      await dbAdapter.deleteUserBan(this.id, user.id);
      monitor.increment('users.unbans');
      await EventService.onUserUnbanned(this.intId, user.intId);
      return 1;
    }

    /**
     * Subscribe this user to targetUser
     *
     * This function is not performs any access checks. It returns 'true' if
     * subscription was successiful and 'false' if this user was already
     * subscribed to the targetUser.
     *
     * @param {User} targetUser
     * @param {object} [params]
     * @returns {boolean}
     */
    async subscribeTo(targetUser, { noEvents = false, homeFeedIds = [] } = {}) {
      const { wasSubscribed, subscribedFeedIds } = await dbAdapter.subscribeUserToUser(
        this.id,
        targetUser.id,
        homeFeedIds,
      );

      if (!wasSubscribed) {
        return false;
      }

      this.subscribedFeedIds = subscribedFeedIds;

      monitor.increment('users.subscriptions');

      if (!noEvents) {
        if (targetUser.isUser()) {
          await EventService.onUserSubscribed(this.intId, targetUser.intId);
        } else {
          await EventService.onGroupSubscribed(this.intId, targetUser);
        }
      }

      return true;
    }

    /**
     * Unsubscribe this user from targetUser
     *
     * This function is not performs any access checks. It returns 'true' if
     * unsubscription was successiful and 'false' if this user was not
     * subscribed to the targetUser before.
     *
     * @param {User} targetUser
     * @returns {boolean}
     */
    async unsubscribeFrom(targetUser) {
      const { wasUnsubscribed, subscribedFeedIds } = await dbAdapter.unsubscribeUserFromUser(
        this.id,
        targetUser.id,
      );

      this.subscribedFeedIds = subscribedFeedIds;

      if (!wasUnsubscribed) {
        return false;
      }

      monitor.increment('users.unsubscriptions');

      if (targetUser.isUser()) {
        await EventService.onUserUnsubscribed(this.intId, targetUser.intId);
      } else {
        await EventService.onGroupUnsubscribed(this.intId, targetUser);
      }

      return true;
    }

    /**
     * Updates the set of user's home feeds that are subscribed to the target
     * user. This user must be subscribed to the target user.
     *
     * @param {string} subscriberId
     * @param {string} targetId
     * @param {string[]} homeFeeds
     * @returns {Promise<boolean>} - false if this user is not subscribed to the
     * target
     */
    async setHomeFeedsSubscribedTo(targetUser, homeFeedIds) {
      return await dbAdapter.updateSubscription(this.id, targetUser.id, homeFeedIds);
    }

    /**
     * Returns IDs of all home feeds that subscribed to targetUser
     * @param {User} targetUser
     * @returns {Promise<string[]>}
     */
    async getHomeFeedIdsSubscribedTo(targetUser) {
      return await dbAdapter.getHomeFeedsSubscribedTo(this.id, targetUser.id);
    }

    getStatistics(viewerId = null) {
      return dbAdapter.getDynamicUserStats(this.id, viewerId);
    }

    newComment(attrs) {
      attrs.userId = this.id;
      monitor.increment('users.comments');
      return new Comment(attrs);
    }

    newAttachment(attrs) {
      attrs.userId = this.id;
      monitor.increment('users.attachments');
      return new Attachment(attrs);
    }

    async updateProfilePicture(filePath) {
      const image = gm(filePath);
      image.sizeAsync = util.promisify(image.size);

      let originalSize;

      try {
        originalSize = await image.sizeAsync();
      } catch {
        throw new BadRequestException('Not an image file');
      }

      this.profilePictureUuid = uuidv4();

      const sizes = [User.PROFILE_PICTURE_SIZE_LARGE, User.PROFILE_PICTURE_SIZE_MEDIUM];

      const promises = sizes.map((size) =>
        this.saveProfilePictureWithSize(filePath, this.profilePictureUuid, originalSize, size),
      );
      await Promise.all(promises);

      this.updatedAt = new Date().getTime();

      const payload = {
        profilePictureUuid: this.profilePictureUuid,
        updatedAt: this.updatedAt.toString(),
      };

      await dbAdapter.updateUser(this.id, payload);
      await pubSub.globalUserUpdate(this.id);
    }

    async saveProfilePictureWithSize(path, uuid, originalSize, size) {
      const origWidth = originalSize.width;
      const origHeight = originalSize.height;
      const retinaSize = size * 2;

      let image = gm(path);
      image.writeAsync = util.promisify(image.write);

      if (origWidth > origHeight) {
        const dx = origWidth - origHeight;
        image = image.crop(origHeight, origHeight, dx / 2, 0);
      } else if (origHeight > origWidth) {
        const dy = origHeight - origWidth;
        image = image.crop(origWidth, origWidth, 0, dy / 2);
      }

      image = image
        .resize(retinaSize, retinaSize)
        .profile(`${__dirname}/../../lib/assets/sRGB.icm`)
        .autoOrient()
        .quality(95);

      if (config.profilePictures.storage.type === 's3') {
        const tmpPictureFile = `${path}.resized.${size}`;
        const destPictureFile = this.getProfilePictureFilename(uuid, size);

        await image.writeAsync(tmpPictureFile);
        await this.uploadToS3(tmpPictureFile, destPictureFile, config.profilePictures);

        return fs.unlink(tmpPictureFile);
      }

      const destPath = this.getProfilePicturePath(uuid, size);
      return image.writeAsync(destPath);
    }

    // Upload profile picture to the S3 bucket
    async uploadToS3(sourceFile, destFile, subConfig) {
      await s3Client().putObject({
        ACL: 'public-read',
        Bucket: subConfig.storage.bucket,
        Key: subConfig.path + destFile,
        Body: createReadStream(sourceFile),
        ContentType: 'image/jpeg',
        ContentDisposition: 'inline',
      });
    }

    getProfilePicturePath(uuid, size) {
      return (
        config.profilePictures.storage.rootDir +
        config.profilePictures.path +
        this.getProfilePictureFilename(uuid, size)
      );
    }

    getProfilePictureFilename(uuid, size) {
      return `${uuid}_${size}.jpg`;
    }

    // used by serializer
    getProfilePictureLargeUrl() {
      if (_.isEmpty(this.profilePictureUuid)) {
        return '';
      }

      return (
        config.profilePictures.url +
        config.profilePictures.path +
        this.getProfilePictureFilename(this.profilePictureUuid, User.PROFILE_PICTURE_SIZE_LARGE)
      );
    }

    // used by serializer
    getProfilePictureMediumUrl() {
      if (_.isEmpty(this.profilePictureUuid)) {
        return '';
      }

      return (
        config.profilePictures.url +
        config.profilePictures.path +
        this.getProfilePictureFilename(this.profilePictureUuid, User.PROFILE_PICTURE_SIZE_MEDIUM)
      );
    }

    get profilePictureLargeUrl() {
      if (_.isEmpty(this.profilePictureUuid)) {
        return '';
      }

      return (
        config.profilePictures.url +
        config.profilePictures.path +
        this.getProfilePictureFilename(this.profilePictureUuid, User.PROFILE_PICTURE_SIZE_LARGE)
      );
    }

    get profilePictureMediumUrl() {
      if (_.isEmpty(this.profilePictureUuid)) {
        return '';
      }

      return (
        config.profilePictures.url +
        config.profilePictures.path +
        this.getProfilePictureFilename(this.profilePictureUuid, User.PROFILE_PICTURE_SIZE_MEDIUM)
      );
    }

    /**
     * Returns true if postingUser can send direct message to
     * this user.
     *
     * @param {User|null} postingUser
     * @returns {Promise<boolean>}
     */
    async acceptsDirectsFrom(postingUser) {
      if (!postingUser || this.id === postingUser.id) {
        return false;
      }

      if (!this.isActive) {
        return false;
      }

      const banIds = await dbAdapter.getUsersBansOrWasBannedBy(this.id);

      if (banIds.includes(postingUser.id)) {
        return false;
      }

      if (this.preferences.acceptDirectsFrom === User.ACCEPT_DIRECTS_FROM_FRIENDS) {
        const friendIds = await this.getFriendIds();

        if (friendIds.includes(postingUser.id)) {
          return true;
        }
      } else if (this.preferences.acceptDirectsFrom === User.ACCEPT_DIRECTS_FROM_ALL) {
        return true;
      }

      return false;
    }

    async updateLastActivityAt() {
      if (!this.isUser()) {
        // update group lastActivity for all subscribers
        const updatedAt = new Date().getTime();
        const payload = { updatedAt: updatedAt.toString() };
        await dbAdapter.updateUser(this.id, payload);
      }
    }

    /**
     * @param {string} toUserId
     * @param {string[]} homeFeedIds - null means the default home feed
     * of subscriber
     * @returns {Promise<boolean>} - true if request was successfully created
     */
    sendSubscriptionRequest(toUserId, homeFeedIds = []) {
      return dbAdapter.createSubscriptionRequest(this.id, toUserId, homeFeedIds);
    }

    /**
     * Accepts subscription request to this user
     *
     * @param {*} fromUser - subscriber
     * @param {*} acceptedBy - user who accepted request, the group admin in
     * case of group account
     * @returns {Promise<boolean>} - false if there is no request
     */
    async acceptSubscriptionRequest(fromUser, acceptedBy = this) {
      const request = await dbAdapter.getSubscriptionRequest(this.id, fromUser.id);

      if (!request) {
        return false;
      }

      await fromUser.subscribeTo(this, { homeFeedIds: request.homefeed_ids });

      if (this.isGroup()) {
        await EventService.onGroupSubscriptionRequestApproved(
          acceptedBy.intId,
          this,
          fromUser.intId,
        );
      } else {
        await EventService.onSubscriptionRequestApproved(fromUser.intId, this.intId);
      }

      return true;
    }

    async rejectSubscriptionRequest(userId) {
      return await dbAdapter.deleteSubscriptionRequest(this.id, userId);
    }

    async getPendingSubscriptionRequestIds() {
      this.pendingSubscriptionRequestIds = await dbAdapter.getUserSubscriptionPendingRequestsIds(
        this.id,
      );
      return this.pendingSubscriptionRequestIds;
    }

    async getPendingSubscriptionRequests() {
      const pendingSubscriptionRequestIds = await this.getPendingSubscriptionRequestIds();
      return await dbAdapter.getUsersByIds(pendingSubscriptionRequestIds);
    }

    async getSubscriptionRequestIds() {
      return await dbAdapter.getUserSubscriptionRequestsIds(this.id);
    }

    async getSubscriptionRequests() {
      const subscriptionRequestIds = await this.getSubscriptionRequestIds();
      return await dbAdapter.getUsersByIds(subscriptionRequestIds);
    }

    async getFollowedGroups() {
      const timelinesIds = await dbAdapter.getUserSubscriptionsIds(this.id);

      if (timelinesIds.length === 0) {
        return [];
      }

      const timelines = await dbAdapter.getTimelinesByIds(timelinesIds);

      if (timelines.length === 0) {
        return [];
      }

      const timelineOwnerIds = _(timelines).map('userId').uniq().value();

      if (timelineOwnerIds.length === 0) {
        return [];
      }

      const timelineOwners = await dbAdapter.getFeedOwnersByIds(timelineOwnerIds);

      if (timelineOwners.length === 0) {
        return [];
      }

      const followedGroups = timelineOwners.filter((owner) => {
        return 'group' === owner.type;
      });

      return followedGroups;
    }

    async getManagedGroups() {
      const groupsIds = await dbAdapter.getManagedGroupIds(this.id);
      return await dbAdapter.getUsersByIds(groupsIds);
    }

    async pendingPrivateGroupSubscriptionRequests() {
      const managedGroups = await this.getManagedGroups();

      const promises = managedGroups.map(async (group) => {
        const unconfirmedFollowerIds = await group.getSubscriptionRequestIds();
        return unconfirmedFollowerIds.length > 0;
      });

      return _.some(await Promise.all(promises), Boolean);
    }

    /**
     * Returns array of comment's hideType's which should not be visible by user
     * @return {string[]}
     */
    getHiddenCommentTypes() {
      return this.preferences.hideCommentsOfTypes;
    }

    getUnreadNotificationsNumber() {
      return dbAdapter.getUnreadEventsNumber(this.id);
    }

    // External authentication profiles

    async getExtProfiles() {
      const profilesFromDb = await dbAdapter.getExtProfiles(this.id);
      return profilesFromDb.filter((p) => allExternalProviders.some((xp) => xp.id === p.provider));
    }

    /**
     * Returns created/updated profile or null if this profile is already belongs to another user
     */
    async addOrUpdateExtProfile({ provider, externalId, title }) {
      if (!allExternalProviders.some((p) => p.id === provider)) {
        throw new Error(`The '${provider}' provider is not supported`);
      }

      return await dbAdapter.addOrUpdateExtProfile({
        userId: this.id,
        provider,
        externalId,
        title,
      });
    }

    /**
     * Returns false if profile was not found for this user
     */
    removeExtProfile(profileId) {
      return dbAdapter.removeExtProfile(this.id, profileId);
    }

    static async getByExtProfile({ provider, externalId }) {
      return await dbAdapter.getUserByExtProfile({ provider, externalId });
    }

    async freeze(freezeTime) {
      await dbAdapter.freezeUser(this.id, freezeTime);
    }

    isFrozen() {
      return dbAdapter.isUserFrozen(this.id);
    }

    frozenUntil() {
      return dbAdapter.userFrozenUntil(this.id);
    }

    async getInvitation() {
      if (!this.invitationId) {
        return null;
      }

      return await dbAdapter.getInvitationById(this.invitationId);
    }

    createInvitation(params) {
      return dbAdapter.createInvitation(
        this.intId,
        params.message,
        params.lang,
        params.singleUse,
        params.users,
        params.groups,
      );
    }

    isInvitesDisabled() {
      return dbAdapter.isInvitesDisabledForUser(this.id);
    }

    setInvitesDisabled(isDisabled) {
      return dbAdapter.setInvitesDisabledForUser(this.id, isDisabled);
    }

    /**
     * Notify of all comments of post (receive the 'post_comment' events)
     * @param {Post} post
     * @param {boolean} enabled
     * @returns {Promise<void>}
     */
    async notifyOfAllCommentsOfPost(post, enabled) {
      await dbAdapter.setCommentEventsStatusForPost(post.id, this.id, enabled);
      await EventService.onPostCommentsListened(this, post, enabled);
    }
  };
}
