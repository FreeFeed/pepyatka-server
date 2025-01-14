import { Knex } from 'knex';
import { Config } from 'config';

import { DbAdapter, type InvitationRecord } from './support/DbAdapter';
import PubSubAdapter from './pubsub';
import { GONE_NAMES } from './models/user';
import { ISO8601DateTimeString, ISO8601DurationString, Nullable, UUID } from './support/types';
import { SessionTokenV1Store } from './models/auth-tokens';
import { List } from './support/open-lists';
import { MediaMetaData, MediaPreviews } from './support/media-files/types';

export const postgres: Knex;
export const dbAdapter: DbAdapter;
export const PubSub: PubSubAdapter;

export class User {
  static ACCEPT_DIRECTS_FROM_ALL: 'all';
  static ACCEPT_DIRECTS_FROM_FRIENDS: 'friends';

  static feedNames: [
    'RiverOfNews',
    'Hides',
    'Comments',
    'Likes',
    'Posts',
    'Directs',
    'MyDiscussions',
    'Saves',
  ];

  id: UUID;
  intId: number;
  username: string;
  screenName: string;
  description: string;
  createdAt: string; // numeric string
  updatedAt: string; // numeric string
  isProtected: '0' | '1';
  isPrivate: '0' | '1';
  profilePictureLargeUrl: string;
  readonly isActive: boolean;
  type: 'user';
  invitationId: number | null;
  goneStatus: keyof typeof GONE_NAMES | null;
  goneStatusName: string;
  constructor(params: unknown);
  create(): Promise<this>;
  update(params: unknown): Promise<void>;
  setGoneStatus(status: keyof typeof GONE_NAMES | null): Promise<void>;
  ban(usernames: string): Promise<1>;
  unban(usernames: string): Promise<1>;
  subscribeTo(
    targetUser: User,
    params?: { noEvents: boolean; homeFeedIds: UUID[] },
  ): Promise<boolean>;
  unsubscribeFrom(targetUser: User): Promise<boolean>;
  getHomeFeeds(): Promise<Timeline[]>;
  getSubscriptionsWithHomeFeeds(): Promise<{ user_id: UUID; homefeed_ids: UUID[] }[]>;
  isGroup(): false;
  isUser(): true;
  getManagedGroups(): Promise<Group[]>;
  getBanIds(): Promise<UUID[]>;
  getPostsTimeline(): Promise<Timeline | null>;
  getDirectsTimeline(): Promise<Timeline | null>;
  isValidEmail(): Promise<boolean>;
  static validateEmail(email: string | null): Promise<void>;
  newComment(params: { body: string; postId: UUID }): Comment;

  getGenericTimeline(name: (typeof User.feedNames)[number]): Promise<Timeline | null>;
  getGenericTimelineId(name: (typeof User.feedNames)[number]): Promise<UUID | null>;
  getGenericTimelineIntId(name: (typeof User.feedNames)[number]): Promise<number | null>;

  getRiverOfNewsTimelineId(): Promise<UUID | null>;
  getHidesTimelineId(): Promise<UUID | null>;
  getCommentsTimelineId(): Promise<UUID | null>;
  getLikesTimelineId(): Promise<UUID | null>;
  getPostsTimelineId(): Promise<UUID | null>;
  getDirectsTimelineId(): Promise<UUID | null>;
  getMyDiscussionsTimelineId(): Promise<UUID | null>;
  getSavesTimelineId(): Promise<UUID | null>;

  getRiverOfNewsTimelineIntId(): Promise<number | null>;
  getHidesTimelineIntId(): Promise<number | null>;
  getCommentsTimelineIntId(): Promise<number | null>;
  getLikesTimelineIntId(): Promise<number | null>;
  getPostsTimelineIntId(): Promise<number | null>;
  getDirectsTimelineIntId(): Promise<number | null>;
  getMyDiscussionsTimelineIntId(): Promise<number | null>;
  getSavesTimelineIntId(): Promise<number | null>;

  freeze(freezeTime: ISO8601DateTimeString | ISO8601DurationString | 'Infinity'): Promise<void>;
  isFrozen(): Promise<boolean>;
  frozenUntil(): Promise<Date | null>;

  getInvitation(): Promise<InvitationRecord | null>;
  createInvitation(params: {
    message: string;
    lang: 'ru' | 'en';
    singleUse: boolean;
    users: string[];
    groups: string[];
  }): Promise<UUID>;
  isInvitesDisabled(): Promise<boolean>;
  setInvitesDisabled(isDisabled: boolean): Promise<void>;

  getStatistics(viewerId?: UUID): Promise<{
    posts: number;
    likes: number;
    comments: number;
    subscribers: number;
    subscriptions: number;
  }>;
  notifyOfAllCommentsOfPost(post: Post, enabled: boolean): Promise<void>;
}

export class Group {
  id: UUID;
  intId: number;
  username: string;
  screenName: string;
  description: string;
  createdAt: string; // numeric string
  updatedAt: string; // numeric string
  type: 'group';
  constructor(params: unknown);
  create(creatorId: UUID): Promise<this>;
  isGroup(): true;
  isUser(): false;
  getAdministrators(): Promise<User[]>;
  getActiveAdministrators(): Promise<User[]>;
  addAdministrator(adminId: UUID, initiatorId?: UUID): Promise<void>;
  getPostsTimeline(): Promise<Timeline | null>;
  getPostsTimelineId(): Promise<UUID | null>;

  blockUser(userId: UUID, adminId: UUID): Promise<boolean>;
  unblockUser(userId: UUID, adminId: UUID): Promise<boolean>;

  enableBansFor(userId: UUID, initiatorId?: UUID): Promise<void>;
  disableBansFor(userId: UUID, initiatorId?: UUID): Promise<void>;
}

type PostUserState = {
  subscribedToComments: boolean;
  saved: boolean;
  hidden: boolean;
};

export class Post {
  id: UUID;
  intId: number;
  userId: UUID;
  body: string;
  destinationFeedIds: number[];
  constructor(params: {
    userId: UUID;
    body: string;
    timelineIds: UUID[];
    commentsDisabled?: '0' | '1';
  });
  create(): Promise<this>;
  destroy(destroyedBy?: User): Promise<void>;
  removeLike(user: User): Promise<boolean>;
  getPostedTo(): Promise<Timeline[]>;
  onlyUsersCanSeePost(fromUsers: User[]): Promise<User[]>;
  getGroupsPostedTo(): Promise<Group[]>;
  getCreatedBy(): Promise<User>;
  isAuthorOrGroupAdmin(user: User): Promise<boolean>;
  usersCanSee(): Promise<List<UUID>>;
  removeDirectRecipient(user: User): Promise<boolean>;
  isVisibleFor(viewer: Nullable<User>): Promise<boolean>;
  getCommentsListeners(): Promise<UUID[]>;
  getUserSpecificProps(user: User): Promise<PostUserState>;
  linkAttachments(attachments: UUID[]): Promise<void>;
}

export class Timeline {
  id: UUID;
  userId: UUID;
  intId: number;
  getUser(): Promise<User | Group>;
  destroy(): Promise<void>;
  isDirects(): boolean;
  isPosts(): boolean;
}

type AttachmentParams = {
  userId: UUID;
  postId?: UUID;
  file: {
    name: string;
    type: string;
    size: number;
    path: string;
  };
};
export class Attachment {
  id: UUID;
  fileName: string;
  fileExtension: string;
  fileSize: number;
  sanitized: number;
  previews: MediaPreviews;
  meta: MediaMetaData;
  width: number | null;
  height: number | null;
  duration: number | null;
  constructor(params: AttachmentParams);
  static create(
    filePath: string,
    fileName: string,
    user: User,
    postId?: UUID | null,
  ): Promise<Attachment>;
  finalizeCreation(filePath: string): Promise<void>;
  getRelFilePath(variant: string, ext?: string | null): string;
  getLocalFilePath(variant: string, ext?: string | null): string;
  getFileUrl(variant: string, ext?: string | null): string;
  allFileVariants(includeOriginal?: boolean): { variant: string; ext: string }[];
  allRelFilePaths(includeOriginal?: boolean): string[];
  maxSizedVariant(mediaType: 'image' | 'video'): string | null;
  downloadOriginal(): Promise<string>;
  sanitizeOriginal(): Promise<boolean>;
  destroy(destroyedBy?: User): Promise<void>;
}

export class Comment {
  static VISIBLE: 0;
  static DELETED: 1;
  // The author of the comment was banned by a viewer
  static HIDDEN_AUTHOR_BANNED: 2;
  static HIDDEN_ARCHIVED: 3;
  // A viewer was banned by the author of the comment
  static HIDDEN_VIEWER_BANNED: 4;
  id: UUID;
  intId: number;
  body: string;
  userId: Nullable<UUID>;
  hideType: 0 | 1 | 2 | 3 | 4;
  postId: UUID;
  seqNumber: number;
  static hiddenBody(hideType: number): string;
  constructor(params: { userId: UUID; body: string; postId: UUID });
  create(): Promise<void>;
  destroy(destroyedBy?: User): Promise<boolean>;
  getPost(): Promise<Post>;
  removeLike(user: User): Promise<boolean>;
  getCreatedBy(): Promise<User>;
  usersCanSee(): Promise<List<UUID>>;
  setHideType(hideType: number): void;
}

export const sessionTokenV1Store: SessionTokenV1Store;

export { AuthToken, AppTokenV1, SessionTokenV1 } from './models/auth-tokens';

export class ServerInfo {}

type JobParams = {
  uniqKey?: string;
  unlockAt?: Date | number;
};

export class Job<T = unknown> {
  name: string;
  payload: T;
  attempts: number;
  failures: number;
  uniqKey: string | null;
  readonly kept: boolean;
  static create<P>(name: string, payload?: P, params?: JobParams): Promise<Job<P>>;
  setUnlockAt(unlockAt?: Date | number, failure?: boolean | null): Promise<void>;
  keep(unlockAt?: Date | number): Promise<void>;
  delete(): Promise<void>;
}

export type JobHandler<P> = (job: Job<P>) => Promise<unknown>;
export type JobMiddleware = (h: JobHandler<unknown>) => JobHandler<unknown>;

export class JobManager {
  limitedJobs: Record<string, number>;
  constructor(params?: Partial<Config['jobManager'] & { limitedJobs: Record<string, number> }>);
  on<P = unknown>(name: string, handler: JobHandler<P>): () => void;
  fetch(count?: number, lockTime?: number): Promise<Job[]>;
  fetchAndProcess(count?: number, lockTime?: number): Promise<Job[]>;
  use(mw: JobMiddleware): void;
}

export {
  HOMEFEED_MODE_CLASSIC,
  HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY,
  HOMEFEED_MODE_FRIENDS_ONLY,
} from './models/timeline';
