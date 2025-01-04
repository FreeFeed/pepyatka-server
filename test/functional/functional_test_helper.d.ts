import { Context } from 'koa';

import { Comment, Group, Post, User } from '../../app/models';
import { UUID } from '../../app/support/types';

export type UserCtx = {
  authToken: string;
  username: string;
  password: string;
  user: User;
  attributes: { email: string };
};

export function createTestUser(username?: string): Promise<UserCtx>;
export function createTestUsers(usernames: string[]): Promise<UserCtx[]>;
export function createUserAsync(
  username: string,
  password?: string,
  attributes?: object,
): Promise<UserCtx>;

export function performJSONRequest(
  method: string,
  path: string,
  body?: any,
  header?: Record<string, string>,
): Promise<{ __httpCode: number }>;

export function authHeaders(userCtx: Pick<UserCtx, 'authToken'> | null): {
  Authorization?: `Bearer ${string}`;
};

export function cmpBy<T>(key: keyof T): (a: T, b: T) => number;

export function justCreatePost(
  authorCtx: UserCtx,
  body: string,
  destNames?: string[],
): Promise<Post>;

export function justCreateComment(authorCtx: UserCtx, postId: UUID, body: string): Promise<Comment>;

export function justCreateGroup(
  creatorCtx: UserCtx,
  username: string,
  screenName?: string,
  opts?: {
    isPrivate?: boolean;
    isProtected?: boolean;
    isRestricted?: boolean;
  },
): Promise<Group>;

export function justLikeComment(commentObj: Comment, userCtx: UserCtx): Promise<void>;

export class MockHTTPServer {
  readonly port: number;
  readonly origin: string;

  constructor(handler: (ctx: Context) => void, opts?: { timeout?: number });
  start(): Promise<void>;
  stop(): Promise<void>;
}
