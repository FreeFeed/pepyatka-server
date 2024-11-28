import { Knex } from 'knex';
import { Cache } from 'cache-manager';

import { IPAddr, ISO8601DateTimeString, ISO8601DurationString, Nullable, UUID } from '../types';
import { AppTokenV1, Attachment, Comment, Group, Post, Timeline, User, Job } from '../../models';
import {
  AppTokenCreateParams,
  AppTokenLogPayload,
  AppTokenRecord,
  SessionCreateRecord,
  SessionMutableRecord,
} from '../../models/auth-tokens/types';
import { SessionTokenV1 } from '../../models/auth-tokens';
import { T_EVENT_TYPE } from '../EventTypes';
import { AdminAction, AdminRole } from '../../models/admins';
import { InvitationCreationCriterion } from '../types/invitations';
import { RefusalReason } from '../../models/invitations';
import { List } from '../open-lists';

import { type UserStats } from './user-stats-dynamic';
import {
  type RegisterOptions as TranslationRegisterOptions,
  type UsageOptions as TranslationUsageOptions,
} from './translation-usage';

type QueryBindings = readonly Knex.RawBinding[] | Knex.ValueDict | Knex.RawBinding;

type CommonDBHelpers = {
  getAll<R = any>(sql: string, bindings?: QueryBindings): Promise<R[]>;
  getRow<R = any>(sql: string, bindings?: QueryBindings): Promise<R>;
  getOne<V = any>(sql: string, bindings?: QueryBindings, column?: string | number): Promise<V>;
  getCol<V = any>(sql: string, bindings?: QueryBindings, column?: string | number): Promise<V[]>;
};

type TrxDBHelpers = {
  transaction(): Promise<Knex.Transaction & CommonDBHelpers>;
  transaction<T>(action: (trx: Knex.Transaction & CommonDBHelpers) => Promise<T>): Promise<T>;
};

type ExtProfileData = {
  id: UUID;
  userId: UUID;
  provider: string;
  externalId: string;
  title: string;
  createdAt: string;
};

export type EventRecord = {
  id: number;
  uid: UUID;
  created_at: Date;
  user_id: number;
  event_type: T_EVENT_TYPE;
  created_by_user_id: Nullable<number>;
  target_user_id: Nullable<number>;
  group_id: Nullable<number>;
  post_id: Nullable<number>;
  comment_id: Nullable<number>;
  post_author_id: Nullable<number>;
  target_post_id: Nullable<UUID>;
  target_comment_id: Nullable<UUID>;
};

type ListAttachmentsOptions = { userId: UUID; limit: number } & (
  | { createdBefore?: string }
  | { createdAfter: string }
  | { offset: number }
);

type AttachmentsSanitizeTask = {
  userId: UUID;
  createdAt: Date;
};

type AttachmentsStats = {
  total: number;
  sanitized: number;
};

export type InvitationRecord = {
  id: number;
  secure_id: UUID;
  author: number;
  message: string;
  lang: 'ru' | 'en';
  single_use: boolean;
  recommendations: { users: string[]; groups: string[] };
  registrations_count: number;
  created_at: Date;
};

export class DbAdapter {
  constructor(connection: Knex);

  database: Knex & CommonDBHelpers & TrxDBHelpers;
  memoryCache: Cache;
  cache: Cache;

  now(): Promise<Date>;

  doInTransaction<T>(action: () => Promise<T>): Promise<T>;

  // Subscription requests
  getUserSubscriptionPendingRequestsIds(userId: UUID): Promise<UUID[]>;
  deleteSubscriptionRequest(toUserId: UUID, fromUserId: UUID): Promise<void>;
  getMutualSubscriptionRequestStatuses(
    userId: UUID | null,
    otherUserIds: UUID[],
  ): Promise<Map<UUID, 0 | 1 | 2 | 3>>;

  // External authentication
  getExtProfiles(userId: UUID): Promise<ExtProfileData[]>;
  removeExtProfile(userId: UUID, profileId: UUID): Promise<boolean>;

  // Users
  getUserById(id: UUID): Promise<User | null>;
  getUserByIntId(intId: number): Promise<User | null>;
  getUsersByIds(ids: UUID[]): Promise<User[]>;
  getUserByUsername(username: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUsersByNormEmail(email: string): Promise<User[]>;
  existsEmail(email: string): Promise<boolean>;
  existsNormEmail(email: string): Promise<boolean>;
  getUsersBansIdsMap(ids: UUID[]): Promise<Map<UUID, UUID[]>>;
  getUsersBanedByIdsMap(ids: UUID[]): Promise<Map<UUID, UUID[]>>;
  getUserIdsWhoBannedUser(id: UUID): Promise<UUID[]>;
  getFeedOwnerById(id: UUID): Promise<User | Group | null>;
  getFeedOwnerByUsername(name: string): Promise<User | Group | null>;
  getFeedOwnersByUsernames(names: string[]): Promise<(User | Group)[]>;
  getFeedOwnersByIds(ids: UUID[]): Promise<Nullable<User | Group>[]>;
  someUsersArePublic(userIds: UUID[], anonymousFriendly: boolean): Promise<boolean>;
  areUsersSubscribedToOneOfTimelines(
    userIds: UUID[],
    timelineIds: UUID[],
  ): Promise<{ uid: UUID; is_subscribed: boolean }[]>;
  getTimelineSubscribersIds(timelineId: UUID): Promise<UUID[]>;
  getGroupAdministratorsIds(id: UUID): Promise<UUID[]>;
  getGroupsAdministratorsIds(
    groupIds: UUID[],
    viewerId?: Nullable<UUID>,
  ): Promise<{ [k: string]: UUID[] }>;
  getUsersByIdsAssoc(ids: UUID[]): Promise<{ [k: string]: User | Group }>;
  getUsersStatsAssoc(ids: UUID[]): Promise<{
    [k: string]: {
      posts: number;
      likes: number;
      comments: number;
      subscribers: number;
      subscriptions: number;
    };
  }>;
  isUserAdminOfGroup(userId: UUID, groupId: UUID): Promise<boolean>;
  getDirectModesMap(
    userIds: UUID[],
  ): Promise<
    Map<UUID, typeof User.ACCEPT_DIRECTS_FROM_ALL | typeof User.ACCEPT_DIRECTS_FROM_FRIENDS>
  >;
  getAllUsersIds(limit?: number, offset?: number, types?: ('user' | 'group')[]): Promise<UUID[]>;
  /**
   * Returns unsorted IDs of users whose username sparse matches `query`.
   */
  sparseMatchesUserIds(query: string): Promise<UUID[]>;

  getUsersIdsByIntIds(intIds: number[]): Promise<{ id: number; uid: UUID }[]>;
  getPostsIdsByIntIds(intIds: number[]): Promise<{ id: number; uid: UUID }[]>;
  getCommentsIdsByIntIds(intIds: number[]): Promise<{ id: number; uid: UUID }[]>;

  // System preferences
  getUserSysPrefs<T>(userId: UUID, key: string, defaultValue: T): Promise<T>;
  setUserSysPrefs<T>(userId: UUID, key: string, value: T): Promise<void>;

  // Freeze
  freezeUser(
    userId: UUID,
    freezeTime: ISO8601DateTimeString | ISO8601DurationString | 'Infinity',
  ): Promise<void>;
  userFrozenUntil(userId: UUID): Promise<Date | null>;
  usersFrozenUntil(userIds: UUID[]): Promise<(Date | null)[]>;
  isUserFrozen(userId: UUID): Promise<boolean>;
  cleanFrozenUsers(): Promise<void>;
  getFrozenUsers(
    limit?: number,
    offset?: number,
  ): Promise<{ userId: UUID; createdAt: Date; expiresAt: Date }[]>;

  // Bans
  getUserBansIds(id: UUID): Promise<UUID[]>;
  getGroupsWithDisabledBans(userId: UUID, groupIds?: UUID[]): Promise<UUID[]>;
  getUsersWithDisabledBansInGroups(
    groupIds: UUID[],
  ): Promise<{ user_id: UUID; is_admin: boolean }[]>;
  disableBansInGroup(userId: UUID, groupId: UUID, doDisable: boolean): Promise<boolean>;

  // Posts
  getPostShortId(longId: UUID): Promise<string | null>;
  getPostLongId(shortId: string): Promise<UUID | null>;
  getPostLongIds(shortIds: string[]): Promise<UUID[]>;
  getPostById(id: UUID): Promise<Post | null>;
  getAdminsOfPostGroups(postId: UUID): Promise<User[]>;
  getPostsByIds(ids: UUID[]): Promise<Post[]>;
  getPostsByIntIds(ids: number[]): Promise<Post[]>;
  filterSuspendedPosts(ids: UUID[]): Promise<UUID[]>;
  withdrawPostFromDestFeed(feedIntId: number, postUUID: UUID): Promise<boolean>;
  getPostsPresentsInTimeline(postIds: UUID[], feedIntId: number): Promise<UUID[]>;

  // Likes
  unlikePost(postId: UUID, userId: UUID): Promise<boolean>;

  // Comments
  getCommentLongIds(shortIds: string[]): Promise<UUID[]>;
  getCommentById(id: UUID): Promise<Comment | null>;
  getCommentsByIds(ids: UUID[]): Promise<Comment[]>;
  getCommentsByIntIds(ids: number[]): Promise<Comment[]>;
  getCommentBySeqNumber(postId: UUID, seqNumber: number): Promise<Comment | null>;

  // Comment likes
  deleteCommentLike(commentUUID: UUID, likerUUID: UUID): Promise<boolean>;
  getLikesInfoForComments(
    commentsUUIDs: UUID[],
    viewerUUID?: UUID,
  ): Promise<{ uid: UUID; c_likes: string; has_own_like: boolean }[]>;

  // Attachments
  getAttachmentById(id: UUID): Promise<Attachment | null>;
  getPostAttachments(id: UUID): Promise<UUID[]>;
  getAttachmentsOfPost(postId: UUID): Promise<Attachment[]>;
  listAttachments(options: ListAttachmentsOptions): Promise<Attachment[]>;
  createAttachmentsSanitizeTask(userId: UUID): Promise<AttachmentsSanitizeTask>;
  getAttachmentsSanitizeTask(userId: UUID): Promise<Nullable<AttachmentsSanitizeTask>>;
  deleteAttachmentsSanitizeTask(userId: UUID): Promise<void>;
  getNonSanitizedAttachments(userId: UUID, limit: number): Promise<Attachment[]>;
  getAttachmentsStats(userId: UUID): Promise<AttachmentsStats>;

  // Timelines
  getTimelinesByIds(ids: UUID[]): Promise<Timeline[]>;
  getAllUserNamedFeed(userId: UUID, feedName: string): Promise<Timeline[]>;
  getUserNamedFeed(userId: UUID, feedName: string): Promise<Nullable<Timeline>>;
  getTimelinesByIntIds(intIds: number[]): Promise<Timeline[]>;

  // Visibility
  postsVisibilitySQL(
    viewerId?: UUID,
    options?: { postsTable: string; postAuthorsTable: string },
  ): Promise<string>;
  notBannedActionsSQLFabric(
    viewerId?: UUID,
  ): Promise<(actionsTable: string, postsTable?: string, useIntBanIds?: boolean) => string>;
  isPostVisibleForViewer(postId: UUID, viewerId?: UUID): Promise<boolean>;
  getUsersWhoCanSeePost(postProps: { authorId: UUID; destFeeds: number[] }): Promise<List<UUID>>;
  isCommentBannedForViewer(commentId: UUID, viewerId?: UUID): Promise<number[] | null>;
  areCommentsBannedForViewerAssoc(
    commentIds: UUID[],
    viewerId?: UUID,
  ): Promise<Map<UUID, number[]>>;

  getGroupsVisibility(accountIds: UUID[], viewerId: UUID | null): Promise<{ [k: UUID]: boolean }>;

  // App tokens
  createAppToken(token: AppTokenCreateParams): Promise<AppTokenV1>;
  getAppTokenById(id: UUID): Promise<Nullable<AppTokenV1>>;
  getActiveAppTokenByIdAndIssue(id: UUID, issue: number): Promise<Nullable<AppTokenV1>>;
  getAppTokenByActivationCode(code: string, codeTTL: number): Promise<Nullable<AppTokenV1>>;
  listActiveAppTokens(userId: UUID): Promise<AppTokenV1[]>;
  updateAppToken(id: UUID, toUpdate: Partial<AppTokenRecord>): Promise<AppTokenV1>;
  reissueAppToken(id: UUID): Promise<AppTokenV1>;
  deleteAppToken(id: UUID): Promise<void>;
  registerAppTokenUsage(
    id: UUID,
    params: { ip: IPAddr; userAgent: string; debounce: string },
  ): Promise<void>;
  logAppTokenRequest(payload: AppTokenLogPayload): Promise<void>;
  periodicInvalidateAppTokens(): Promise<void>;

  // Session tokens
  createAuthSession(params: SessionCreateRecord): Promise<SessionTokenV1>;
  getAuthSessionById(id: UUID): Promise<Nullable<SessionTokenV1>>;
  reissueActiveAuthSession(id: UUID): Promise<Nullable<SessionTokenV1>>;
  updateAuthSession(id: UUID, toUpdate: SessionMutableRecord): Promise<Nullable<SessionTokenV1>>;
  registerAuthSessionUsage(
    uid: UUID,
    params: { ip: IPAddr; userAgent: string; debounceSec: number },
  ): Promise<Nullable<SessionTokenV1>>;
  deleteAuthSession(id: UUID): Promise<boolean>;
  listAuthSessions(userId: UUID): Promise<SessionTokenV1[]>;
  cleanOldAuthSessions(activeTTLDays: number, inactiveTTLDays: number): Promise<void>;

  createEvent(
    recipientIntId: number,
    eventType: T_EVENT_TYPE,
    createdByUserIntId: Nullable<number>,
    targetUserIntId?: Nullable<number>,
    groupIntId?: Nullable<number>,
    postId?: Nullable<UUID>,
    commentId?: Nullable<UUID>,
    postAuthorIntId?: Nullable<number>,
    targetPostId?: Nullable<UUID>,
    targetCommentId?: Nullable<UUID>,
  ): Promise<EventRecord>;
  getEventById(eventId: UUID): Promise<Nullable<EventRecord>>;
  getUserEvents(
    userIntId: number,
    eventTypes?: string[],
    limit?: number,
    offset?: number,
    startDate?: Date,
    endDate?: Date,
  ): Promise<EventRecord[]>;

  getUnreadDirectsNumber(userId: UUID): Promise<number>;
  getUnreadEventsNumber(userId: UUID): Promise<number>;

  // Backlinks
  getBacklinksCounts(uuids: UUID[], viewerId?: Nullable<UUID>): Promise<Map<UUID, number>>;
  updateBacklinks(
    text: string,
    refPostUID: UUID,
    refCommentUID?: Nullable<UUID>,
    db?: Knex,
  ): Promise<void>;
  getReferringPosts(
    postId: UUID,
    viewerId?: Nullable<UUID>,
    params?: {
      limit?: number;
      offset?: number;
      sort?: 'bumped' | 'created';
      createdBefore?: Nullable<ISO8601DateTimeString>;
      createdAfter?: Nullable<ISO8601DateTimeString>;
    },
  ): Promise<UUID[]>;

  // Jobs
  createJob<T extends {}>(
    name: string,
    payload: T,
    params: { unlockAt?: Date | number; uniqKey?: string },
  ): Promise<Job<T>>;
  updateJob(id: UUID, params: { unlockAt?: Date | number; failure?: boolean | null }): Promise<Job>;
  getJobById(id: UUID): Promise<Nullable<Job>>;
  deleteJob(id: UUID): Promise<void>;
  fetchJobs(count: number, lockTime: number, limitedJobs?: Record<string, number>): Promise<Job[]>;
  getAllJobs(names?: string[]): Promise<Job[]>; // For testing purposes only

  // Group blocks
  blockUserInGroup(userId: UUID, groupId: UUID): Promise<boolean>;
  unblockUserInGroup(userId: UUID, groupId: UUID): Promise<boolean>;
  userIdsBlockedInGroup(groupId: UUID): Promise<UUID[]>;
  groupIdsBlockedUser(userId: UUID, fromGroupIds?: UUID[]): Promise<UUID[]>;

  // Subscriptions
  getOnlySubscribedTo(subscriberId: UUID | null, toUserIds: UUID[]): Promise<UUID[]>;
  getMutualSubscriptionStatuses(
    userId: UUID | null,
    otherUserIds: UUID[],
  ): Promise<Map<UUID, 0 | 1 | 2 | 3>>;
  isUserSubscribedToTimeline(userId: UUID, feedId: UUID): Promise<boolean>;
  getUserFriendIds(userId: UUID): Promise<UUID[]>;

  // Email verification
  createEmailVerificationCode(email: string, ipAddress: IPAddr): Promise<string | null>;
  checkEmailVerificationCode(code: string, email: string): Promise<boolean>;
  cleanOldEmailVerificationCodes(): Promise<void>;

  // Admin-related methods
  getUserAdminRoles(userId: UUID): Promise<AdminRole[]>;
  getUsersAdminRolesAssoc(userIds: UUID[]): Promise<{ [id: UUID]: AdminRole[] }>;
  setUserAdminRole(
    userId: UUID,
    role: AdminRole,
    doSet?: boolean,
    flags?: { YES_I_WANT_TO_SET_ADMIN_FOR_TEST_ONLY: boolean },
  ): Promise<boolean>;
  getUsersWithAdminRoles(): Promise<UUID[]>;
  createAdminAction(
    action_name: AdminAction,
    admin: { username: string },
    target_user?: { username: string } | null,
    details?: object,
  ): Promise<UUID>;
  getAdminActions(
    limit?: number,
    offset?: number,
  ): Promise<
    {
      id: UUID;
      created_at: Date;
      action_name: AdminAction;
      admin_username: string;
      target_username: string | null;
      details: object;
    }[]
  >;

  // Invitations
  getInvitation(secureId: UUID): Promise<InvitationRecord | null>;
  getInvitationById(id: number): Promise<InvitationRecord | null>;
  createInvitation(
    authorIntId: number,
    message: string,
    lang: 'ru' | 'en',
    singleUse: boolean,
    userNames: string[],
    groupNames: string[],
  ): Promise<[UUID]>;
  useInvitation(secureId: UUID): Promise<void>;
  canUserCreateInvitation(
    userId: UUID,
    criteria: InvitationCreationCriterion[],
  ): Promise<RefusalReason | null>;
  setInvitesDisabledForUser(userId: UUID, isDisabled: boolean): Promise<void>;
  isInvitesDisabledForUser(userId: UUID): Promise<boolean>;
  getInvitedByAssoc(userIds: UUID[]): Promise<Record<UUID, string>>;

  // User stats
  getDynamicUserStats(userId: UUID, viewerId: UUID | null): Promise<UserStats>;

  // Translation usage
  registerTranslationUsage(options: TranslationRegisterOptions): Promise<void>;
  getTranslationUsage(options: TranslationUsageOptions): Promise<number>;
  cleanOldTranslationUsageData(now?: ISO8601DateTimeString | 'now'): Promise<void>;

  getCommentEventsStatusForPosts(
    viewerId: UUID | null,
    postIds: UUID[],
  ): Promise<Map<UUID, boolean>>;
  getCommentEventsListenersForPost(postId: UUID): Promise<Map<UUID, boolean>>;
  setCommentEventsStatusForPost(postId: UUID, userId: UUID, isEnabled: boolean): Promise<void>;
  cleanCommentEventsSubscriptions(userId: UUID): Promise<void>;
}
