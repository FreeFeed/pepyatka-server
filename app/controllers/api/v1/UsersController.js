import crypto from 'crypto';
import util from 'util';

import monitorDog from 'monitor-dog';
import _ from 'lodash';
import compose from 'koa-compose';

import {
  dbAdapter,
  User,
  Group,
  AppTokenV1,
  ServerInfo,
  sessionTokenV1Store,
} from '../../../models';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  NotAuthorizedException,
  BadRequestException,
  TooManyRequestsException,
} from '../../../support/exceptions';
import { verifyJWTAsync } from '../../../support/verifyJWTAsync';
import { EventService } from '../../../support/EventService';
import recaptchaVerify from '../../../../lib/recaptcha';
import { serializeUsersByIds } from '../../../serializers/v2/user';
import {
  authRequired,
  targetUserRequired,
  monitored,
  inputSchemaRequired,
} from '../../middlewares';
import { UsersControllerV2 } from '../../../controllers';
import { profileCache } from '../../../support/ExtAuth';
import { downloadURL } from '../../../support/download-url';
import { GONE_COOLDOWN } from '../../../models/user';

import {
  userCreateInputSchema,
  userSubscribeInputSchema,
  updateSubscriptionInputSchema,
  sendRequestInputSchema,
  userSuspendMeInputSchema,
  userResumeMeInputSchema,
} from './data-schemes';

const randomBytes = util.promisify(crypto.randomBytes);

/** @typedef {import('../../../support/types').Ctx} Ctx */

export default class UsersController {
  static create = compose([
    inputSchemaRequired(userCreateInputSchema),
    /** @param {Ctx} ctx */
    async (ctx) => {
      const registrationOpen = await ServerInfo.isRegistrationOpen();

      if (!registrationOpen) {
        throw new TooManyRequestsException('New user registrations are temporarily suspended');
      }

      const { config } = ctx;

      const params = {
        username: ctx.request.body.username,
        screenName: ctx.request.body.screenName,
        email: ctx.request.body.email,
        // may be empty if externalProfileKey is present
        password: ctx.request.body.password,
        isPrivate: ctx.request.body.isPrivate ? '1' : '0',
        isProtected: ctx.request.body.isPrivate || ctx.request.body.isProtected ? '1' : '0',
        invitationId: null,
      };

      if (ctx.config.recaptcha.enabled) {
        await recaptchaVerify(ctx.request.body.captcha, ctx.request.ip);
      }

      let extProfileData = null;

      /**
       * The 'externalProfileKey' parameter holds the key of profileCache.
       * If this parameter is present then the user is registered via the
       * external identity provider and must be linked to the external auth
       * profile. In this case the password will be randomly generated.
       */
      if (ctx.request.body.externalProfileKey) {
        // Do not checking result: at this point we can not return.
        // If record is not found just create account with random password.
        extProfileData = await profileCache.get(ctx.request.body.externalProfileKey);

        // If the externalProfileKey is defined then we should auto-generate password
        params.password = (await randomBytes(8)).toString('base64');
      }

      const invitationId = ctx.request.body.invitation;
      /** @type {import('../../../support/DbAdapter').InvitationRecord|null} */
      let invitation;

      if (invitationId) {
        invitation = await dbAdapter.getInvitation(invitationId);
        invitation = await validateInvitationAndSelectUsers(invitation, invitationId);
        params.invitationId = invitation.id;
      }

      if (config.invitations.requiredForSignUp) {
        if (!invitation) {
          throw new ValidationException('Invitation required');
        }

        if (!invitation.single_use) {
          throw new ValidationException('Only single-use invitation is accepted');
        }

        const inviteAuthor = await dbAdapter.getUserByIntId(invitation.author);

        if (await inviteAuthor.isInvitesDisabled()) {
          throw new ValidationException('This invitation is not active');
        }
      }

      const user = new User(params);
      await user.validateOnCreate();

      if (ctx.config.emailVerification.enabled) {
        if (!params.email) {
          throw new ValidationException('Email address required');
        }

        if (await dbAdapter.existsNormEmail(params.email)) {
          // email is taken
          throw new ValidationException('This email address is already in use');
        }

        if (extProfileData?.email !== params.email) {
          if (ctx.request.body.emailVerificationCode) {
            const ok = await dbAdapter.checkEmailVerificationCode(
              ctx.request.body.emailVerificationCode,
              params.email,
            );

            if (!ok) {
              throw new ValidationException('Invalid or outdated email verification code');
            }
          } else {
            throw new ValidationException('Email verification code required');
          }
        }
      }

      await user.create(false);

      const safeRun = async (foo) => {
        try {
          await foo();
        } catch {
          // pass
        }
      };

      // After-creation tasks can be silently failed
      await Promise.all([
        // Connect to external authorization profile
        extProfileData && safeRun(() => user.addOrUpdateExtProfile(extProfileData)),
        // Register invitation and subscribe to suggested feeds
        invitation &&
          safeRun(() => useInvitation(user, invitation, ctx.request.body.cancel_subscription)),
        // Subscribe to onboarding user
        safeRun(async () => {
          const onboardingUser = await dbAdapter.getFeedOwnerByUsername(
            ctx.config.onboardingUsername,
          );

          if (onboardingUser) {
            await user.subscribeTo(onboardingUser);
          }
        }),
        // Download and set profile picture by URL
        ctx.request.body.profilePictureURL &&
          safeRun(async () => {
            const fileInfo = await downloadURL(ctx.request.body.profilePictureURL);

            try {
              if (/^image\//.test(fileInfo.type)) {
                await user.updateProfilePicture(fileInfo.path);
              }
            } finally {
              await fileInfo.unlink();
            }
          }),
      ]);

      ctx.state.user = user;
      ctx.state.authToken = await sessionTokenV1Store.create(user.id, ctx);
      await UsersControllerV2.whoAmI(ctx);
      ctx.body.authToken = ctx.state.authToken.tokenString();

      AppTokenV1.addLogPayload(ctx, { userId: user.id });
    },
  ]);

  /** @param {Ctx} ctx */
  static async sudoCreate(ctx) {
    const params = {
      username: ctx.request.body.username,
      email: ctx.request.body.email,
    };

    params.hashedPassword = ctx.request.body.password_hash;

    if (!ctx.config.acceptHashedPasswordsOnly) {
      params.password = ctx.request.body.password;
    }

    const user = new User(params);
    await user.create(true);

    try {
      const onboardingUser = await dbAdapter.getFeedOwnerByUsername(ctx.config.onboardingUsername);

      if (null === onboardingUser) {
        throw new NotFoundException(`Feed "${ctx.config.onboardingUsername}" is not found`);
      }

      await user.subscribeTo(onboardingUser);
    } catch {
      // if onboarding username is not found, just pass
    }

    ctx.state.user = user;
    ctx.state.authToken = await sessionTokenV1Store.create(user.id, ctx);
    await UsersControllerV2.whoAmI(ctx);
    ctx.body.authToken = ctx.state.authToken.tokenString();
  }

  // This method handles both user and group requests
  static sendRequest = compose([
    authRequired(),
    targetUserRequired(),
    inputSchemaRequired(sendRequestInputSchema),
    async (ctx) => {
      const { user, targetUser } = ctx.state;

      if (!targetUser.isActive) {
        throw new ForbiddenException(
          `The ${targetUser.isUser() ? 'user account' : 'group'} is not active`,
        );
      }

      if (targetUser.isPrivate !== '1') {
        throw new ForbiddenException(
          `The ${targetUser.isUser() ? 'user account' : 'group'} is not private`,
        );
      }

      const hasRequest = await dbAdapter.isSubscriptionRequestPresent(user.id, targetUser.id);

      if (hasRequest) {
        throw new ForbiddenException(
          `You have already sent a subscription request to this ${targetUser.type}`,
        );
      }

      const banIds = await targetUser.getBanIds();

      if (banIds.includes(user.id)) {
        // Silently skip request creation because the requestor is blocked
        ctx.body = {};
        return;
      }

      const postsTimelineId = await targetUser.getPostsTimelineId();
      const isSubscribed = await dbAdapter.isUserSubscribedToTimeline(user.id, postsTimelineId);

      if (isSubscribed) {
        throw new ForbiddenException(`You are already subscribed to this ${targetUser.type}`);
      }

      await user.sendSubscriptionRequest(targetUser.id, ctx.request.body.homeFeeds);

      if (targetUser.isUser()) {
        await EventService.onSubscriptionRequestCreated(user.intId, targetUser.intId);
      } else {
        await EventService.onGroupSubscriptionRequestCreated(user.intId, targetUser);
      }

      ctx.body = {};
    },
  ]);

  static acceptRequest = compose([
    authRequired(),
    targetUserRequired(),
    async (ctx) => {
      const { user: targetUser, targetUser: subscriber } = ctx.state;

      const ok = await targetUser.acceptSubscriptionRequest(subscriber);

      if (!ok) {
        throw new ForbiddenException('There is no subscription requests');
      }

      ctx.body = {};
    },
  ]);

  static async rejectRequest(ctx) {
    if (!ctx.state.user) {
      ctx.status = 401;
      ctx.body = { err: 'Not found' };
      return;
    }

    const user = await dbAdapter.getUserByUsername(ctx.params.username);

    if (null === user) {
      throw new NotFoundException(`User "${ctx.params.username}" is not found`);
    }

    const hasRequest = await dbAdapter.isSubscriptionRequestPresent(user.id, ctx.state.user.id);

    if (!hasRequest) {
      throw new Error('Invalid');
    }

    await ctx.state.user.rejectSubscriptionRequest(user.id);
    await EventService.onSubscriptionRequestRejected(user.intId, ctx.state.user.intId);
    ctx.body = {};
  }

  static show = compose([
    targetUserRequired(),
    monitored('users.show'),
    async (ctx) => {
      const { targetUser, user: viewer } = ctx.state;

      const [serUsers, acceptsDirects, pastUsernames, inHomeFeeds, invitation] = await Promise.all([
        serializeUsersByIds([targetUser.id], viewer?.id),
        targetUser.acceptsDirectsFrom(viewer),
        targetUser.getPastUsernames(),
        viewer ? viewer.getHomeFeedIdsSubscribedTo(targetUser) : [],
        targetUser.getInvitation(),
      ]);

      const users = serUsers.find((u) => u.id === targetUser.id);
      const admins = serUsers.filter((u) => u.type === 'user');
      const invitedBy = invitation ? await dbAdapter.getUserByIntId(invitation.author) : null;

      ctx.body = {
        users,
        admins,
        acceptsDirects,
        pastUsernames,
        inHomeFeeds,
        invitedBy: invitedBy?.username ?? null,
      };
    },
  ]);

  static showMe = compose([
    authRequired(),
    monitored('users.show-me'),
    async (ctx) => {
      ctx.params.username = ctx.state.user.username;
      await UsersController.show(ctx);
    },
  ]);

  static suspendMe = compose([
    authRequired(),
    inputSchemaRequired(userSuspendMeInputSchema),
    monitored('users.suspend-me'),
    async (ctx) => {
      const { user } = ctx.state;
      const { password } = ctx.request.body;

      if (!(await user.validPassword(password))) {
        throw new ForbiddenException('Provided password is invalid');
      }

      await user.setGoneStatus(GONE_COOLDOWN);
      ctx.body = { message: 'Your account has been suspended' };
    },
  ]);

  static resumeMe = compose([
    inputSchemaRequired(userResumeMeInputSchema),
    monitored('users.resume-me'),
    /** @param {Ctx} ctx */
    async (ctx) => {
      const token = await verifyJWTAsync(ctx.request.body.resumeToken, ctx.config.secret);

      if (token.type !== 'resume-account') {
        throw new ForbiddenException('Unknown token type');
      }

      const user = await dbAdapter.getUserById(token.userId);

      if (user?.isActive) {
        throw new ForbiddenException('This account is already active');
      }

      if (!user?.isResumable) {
        throw new ForbiddenException('This account cannot be resumed');
      }

      await user.setGoneStatus(null);
      ctx.body = { message: 'Your account has been resumed' };
    },
  ]);

  static subscribers = compose([
    targetUserRequired(),
    monitored('users.subscribers'),
    async (ctx) => {
      const { user: viewer, targetUser: user } = ctx.state;

      if (!viewer && user.isPrivate === '1') {
        throw new ForbiddenException('User is private');
      }

      if (!viewer && user.isProtected === '1') {
        throw new ForbiddenException('User is protected');
      }

      const subscriberIds = await dbAdapter.getUserSubscribersIds(user.id);

      if (user.isPrivate === '1' && viewer.id !== user.id && !subscriberIds.includes(viewer.id)) {
        throw new ForbiddenException('User is private');
      }

      let subscribers = await serializeUsersByIds(subscriberIds, viewer?.id);

      if (viewer?.id !== user.id) {
        // Sort by 'random' id to mask actual subscription order
        subscribers = _.sortBy(subscribers, 'id');
      }

      ctx.body = { subscribers };
    },
  ]);

  static subscriptions = compose([
    targetUserRequired(),
    monitored('users.subscriptions'),
    async (ctx) => {
      const { user: viewer, targetUser: user } = ctx.state;

      if (!viewer && user.isPrivate === '1') {
        throw new ForbiddenException('User is private');
      }

      if (!viewer && user.isProtected === '1') {
        throw new ForbiddenException('User is protected');
      }

      const subscriberIds = await dbAdapter.getUserSubscribersIds(user.id);

      if (user.isPrivate === '1' && viewer.id !== user.id && !subscriberIds.includes(viewer.id)) {
        throw new ForbiddenException('User is private');
      }

      let timelines = await dbAdapter.getTimelinesUserSubscribed(user.id);
      let timelineOwnersIds = timelines.map((t) => t.userId);

      // Leave only users and groups visible to viewer
      const groupsVisibility = await dbAdapter.getGroupsVisibility(
        timelineOwnersIds,
        viewer && viewer.id,
      );
      timelineOwnersIds = timelineOwnersIds.filter((id) => groupsVisibility[id] !== false);
      timelines = timelines.filter(({ userId }) => groupsVisibility[userId] !== false);

      let subscribers = await serializeUsersByIds(timelineOwnersIds, viewer?.id, false);
      let subscriptions = timelines.map((t) => ({
        id: t.id,
        name: t.name,
        user: t.userId,
      }));

      if (viewer?.id !== user.id) {
        // Sort by 'random' id to mask actual subscription order
        subscribers = _.sortBy(subscribers, 'id');
        subscriptions = _.sortBy(subscriptions, 'user', 'name', 'id');
      }

      ctx.body = { subscribers, subscriptions };
    },
  ]);

  static async ban(ctx) {
    if (!ctx.state.user) {
      ctx.status = 401;
      ctx.body = { err: 'Not found' };
      return;
    }

    try {
      const status = await ctx.state.user.ban(ctx.params.username);
      ctx.body = { status };
    } catch (e) {
      if (e.code === '23505') {
        // '23505' stands for unique_violation
        // see https://www.postgresql.org/docs/current/static/errcodes-appendix.html
        throw new ForbiddenException("You can't ban user, who's already banned");
      }

      throw e;
    }
  }

  static async unban(ctx) {
    if (!ctx.state.user) {
      ctx.status = 401;
      ctx.body = { err: 'Not found' };
      return;
    }

    const status = await ctx.state.user.unban(ctx.params.username);
    ctx.body = { status };
  }

  static subscribe = compose([
    authRequired(),
    targetUserRequired(),
    inputSchemaRequired(userSubscribeInputSchema),
    monitored('users.subscribe'),
    async (ctx) => {
      const { user: subscriber, targetUser } = ctx.state;

      if (subscriber.id === targetUser.id) {
        throw new ForbiddenException('You cannot subscribe to yourself');
      }

      if (targetUser.isPrivate === '1') {
        throw new ForbiddenException('You cannot subscribe to private feed');
      }

      const [banIds, theirBanIds] = await Promise.all([
        subscriber.getBanIds(),
        targetUser.getBanIds(),
      ]);

      if (banIds.includes(targetUser.id)) {
        throw new ForbiddenException('You cannot subscribe to a banned user');
      }

      if (theirBanIds.includes(subscriber.id)) {
        throw new ForbiddenException('This user prevented your from subscribing to them');
      }

      const success = await subscriber.subscribeTo(targetUser, {
        homeFeedIds: ctx.request.body.homeFeeds || [],
      });

      if (!success) {
        throw new ForbiddenException('You are already subscribed to that user');
      }

      // should return the same response as 'whoami'
      await UsersControllerV2.whoAmI(ctx);
    },
  ]);

  static updateSubscription = compose([
    authRequired(),
    targetUserRequired(),
    inputSchemaRequired(updateSubscriptionInputSchema),
    monitored('users.updateSubscription'),
    async (ctx) => {
      const { user: subscriber, targetUser } = ctx.state;

      const success = await subscriber.setHomeFeedsSubscribedTo(
        targetUser,
        ctx.request.body.homeFeeds,
      );

      if (!success) {
        throw new ForbiddenException('You are not subscribed to that user');
      }

      await UsersController.show(ctx);
    },
  ]);

  static unsubscribeUser = compose([
    authRequired(),
    targetUserRequired(),
    monitored('users.unsubscribeUser'),
    async (ctx) => {
      const subscriber = ctx.state.user;

      const { username } = ctx.params;
      const targetUser = await dbAdapter.getFeedOwnerByUsername(username);

      if (!targetUser) {
        throw new NotFoundException(`User "${username}" is not found`);
      }

      const success = await targetUser.unsubscribeFrom(subscriber);

      if (!success) {
        throw new ForbiddenException('This user is not subscribed to you');
      }

      // should return the same response as 'whoami'
      await UsersControllerV2.whoAmI(ctx);
    },
  ]);

  static unsubscribe = compose([
    authRequired(),
    targetUserRequired(),
    monitored('users.unsubscribe'),
    async (ctx) => {
      const { user: subscriber, targetUser } = ctx.state;

      if (targetUser.isGroup()) {
        const adminIds = await targetUser.getAdministratorIds();

        if (adminIds.includes(subscriber.id)) {
          throw new ForbiddenException('Group administrators cannot unsubscribe from own groups');
        }
      }

      const success = await subscriber.unsubscribeFrom(targetUser);

      if (!success) {
        throw new ForbiddenException('You are not subscribed to that user');
      }

      // should return the same response as 'whoami'
      await UsersControllerV2.whoAmI(ctx);
    },
  ]);

  static update = compose([
    authRequired(),
    monitored('users.update'),
    /** @param {Ctx} ctx */
    async (ctx) => {
      const {
        state: { user, authToken },
        request: { body },
        params,
      } = ctx;

      if (params.userId !== user.id) {
        throw new NotAuthorizedException();
      }

      const attrNames = [
        'screenName',
        'isPrivate',
        'isProtected',
        'description',
        'frontendPreferences',
        'preferences',
      ];

      // Only full access tokens can change email
      if (authToken.hasFullAccess) {
        attrNames.push('email');
      }

      const attrs = attrNames.reduce((acc, key) => {
        if (key in body.user) {
          acc[key] = ctx.request.body.user[key];
        }

        return acc;
      }, {});

      if (
        ctx.config.emailVerification.enabled &&
        attrNames.includes('email') &&
        'email' in ctx.request.body.user &&
        // Not-strict equality here to compare, i.e. null with ''
        user.email != attrs.email
      ) {
        if (ctx.request.body.emailVerificationCode) {
          const ok = await dbAdapter.checkEmailVerificationCode(
            ctx.request.body.emailVerificationCode,
            attrs.email,
          );

          if (!ok) {
            throw new ValidationException('Invalid or outdated email verification code');
          }
        } else {
          throw new ValidationException('Email verification code required');
        }
      }

      await user.update(attrs);

      // should return the same response as 'whoami'
      await UsersControllerV2.whoAmI(ctx);
    },
  ]);

  static async updatePassword(ctx) {
    if (!ctx.state.user) {
      ctx.status = 401;
      ctx.body = { err: 'Not found' };
      return;
    }

    const currentPassword = ctx.request.body.currentPassword || '';
    const valid = await ctx.state.user.validPassword(currentPassword);

    if (!valid) {
      throw new ForbiddenException('Your old password is not valid');
    }

    await ctx.state.user.updatePassword(
      ctx.request.body.password,
      ctx.request.body.passwordConfirmation,
    );
    ctx.body = { message: 'Your password has been changed' };
  }

  /**
   * File can be sent as 'file' field of multipart/form-data request
   * or as 'url' field of regular JSON body. In the latter case the
   * server will download file from the given url.
   */
  static updateProfilePicture = compose([
    authRequired(),
    async (ctx) => {
      const { user } = ctx.state;

      let filePath = null;

      if (ctx.request.files && ctx.request.files.file) {
        filePath = ctx.request.files.file.filepath;
      } else if (ctx.request.body.url) {
        const fileInfo = await downloadURL(ctx.request.body.url);

        if (!/^image\//.test(fileInfo.type)) {
          await fileInfo.unlink();
          throw new Error(`Unsupported content type: '${fileInfo.type}'`);
        }

        filePath = fileInfo.path;
      }

      if (!filePath) {
        throw new BadRequestException('Neither file nor URL was found');
      }

      await user.updateProfilePicture(filePath);
      ctx.body = { message: 'Your profile picture has been updated' };
    },
  ]);
}

async function validateInvitationAndSelectUsers(invitation, invitationId) {
  if (!invitation) {
    throw new NotFoundException(`Invitation "${invitationId}" not found`);
  }

  const invAuthor = await dbAdapter.getUserByIntId(invitation.author);

  if (!invAuthor.isActive) {
    throw new NotFoundException(`Invitation "${invitationId}" not found`);
  }

  if (invitation.registrations_count > 0 && invitation.single_use) {
    throw new ValidationException(`Somebody has already used invitation "${invitationId}"`);
  }

  const userNames = invitation.recommendations.users || [];
  const groupNames = invitation.recommendations.groups || [];

  const users = await dbAdapter.getFeedOwnersByUsernames(userNames);
  const publicUsers = [];
  const privateUsers = [];

  for (const user of users) {
    if (!(user instanceof User)) {
      throw new ValidationException(`User not found "${user.username}"`);
    }

    if (user.isPrivate === '1') {
      privateUsers.push(user);
    } else {
      publicUsers.push(user);
    }
  }

  const groups = await dbAdapter.getFeedOwnersByUsernames(groupNames);
  const publicGroups = [];
  const privateGroups = [];

  for (const group of groups) {
    if (!(group instanceof Group)) {
      throw new ValidationException(`Group not found "${group.username}"`);
    }

    if (group.isPrivate === '1') {
      privateGroups.push(group);
    } else {
      publicGroups.push(group);
    }
  }

  return { ...invitation, publicUsers, privateUsers, publicGroups, privateGroups };
}

async function useInvitation(newUser, invitation, cancel_subscription = false) {
  await dbAdapter.useInvitation(invitation.secure_id);
  monitorDog.increment('invitation.use-requests', 1);
  await EventService.onInvitationUsed(invitation.author, newUser.intId);

  if (cancel_subscription) {
    return;
  }

  await Promise.all(
    invitation.publicUsers.map((recommendedUser) => {
      return newUser.subscribeTo(recommendedUser);
    }),
  );

  await Promise.all(
    invitation.publicGroups.map((recommendedGroup) => {
      return newUser.subscribeTo(recommendedGroup);
    }),
  );

  await Promise.all(
    invitation.privateUsers.map(async (recommendedUser) => {
      await newUser.sendSubscriptionRequest(recommendedUser.id);
      return EventService.onSubscriptionRequestCreated(newUser.intId, recommendedUser.intId);
    }),
  );

  await Promise.all(
    invitation.privateGroups.map(async (recommendedGroup) => {
      await newUser.sendSubscriptionRequest(recommendedGroup.id);
      return EventService.onGroupSubscriptionRequestCreated(newUser.intId, recommendedGroup);
    }),
  );
}
