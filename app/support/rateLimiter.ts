import crypto from 'crypto';

import monitor from 'monitor-dog'; // search keyword: datadog
import { Context, Next } from 'koa';
import RateLimiter from 'async-ratelimiter';
import Redis from 'ioredis';
import config from 'config';
import createDebug from 'debug';
import { Duration } from 'luxon';

import { TooManyRequestsException } from './exceptions';

const debug = createDebug('freefeed:rateLimiter');

const options = {
  host: config.redis.host,
  port: config.redis.port,
  db: config.database,
};
const redis = new Redis(options);
const rateLimiter = new RateLimiter({
  db: redis,
});

export const durationToSeconds = (duration: string): number => {
  return Duration.fromISO(duration).toMillis() / 1000;
};

const USER_BLOCKED_KEY_PREFIX = 'blocked-';
const BLOCK_COUNTER_KEY_PREFIX = 'blockcounter-';

const MASKING_KEY = 'maskingkey';
const maskingKeyRotationIntervalSeconds = durationToSeconds(
  config.rateLimit.maskingKeyRotationInterval,
);

const changeMaskingKey = async () => {
  const newMaskingKey = crypto.randomBytes(64).toString('hex');
  await redis.set(MASKING_KEY, newMaskingKey, 'EX', maskingKeyRotationIntervalSeconds);
  return newMaskingKey;
};

const maskClientId = (clientId: string, key: string): string => {
  return crypto.createHmac('sha1', key).update(clientId).digest('hex');
};

const isClientBlocked = async (clientId: string): Promise<boolean> => {
  return Boolean(await redis.get(`${USER_BLOCKED_KEY_PREFIX}${clientId}`));
};

const setClientBlocked = async (clientId: string, durationSeconds: number) => {
  return await redis.set(`${USER_BLOCKED_KEY_PREFIX}${clientId}`, 'true', 'EX', durationSeconds);
};

const getClientBlockedDuration = async (clientId: string) => {
  return await redis.ttl(`${USER_BLOCKED_KEY_PREFIX}${clientId}`);
};

const getRepeatBlocksCount = async (clientId: string): Promise<number> => {
  const count = await redis.get(`${BLOCK_COUNTER_KEY_PREFIX}${clientId}`);
  return count ? parseInt(count, 10) : 0;
};

const setRepeatBlocksCount = async (clientId: string, count: number, durationSeconds: number) => {
  return await redis.set(`${BLOCK_COUNTER_KEY_PREFIX}${clientId}`, count, 'EX', durationSeconds);
};

export async function rateLimiterMiddleware(ctx: Context, next: Next) {
  const authTokenType = ctx.state.authJWTPayload?.type || 'anonymous';
  const requestId = ctx.state.id;
  const requestMethod = ctx.request.method;
  const matchedAPIRoute = ctx.state.matchedRoute.replace(/^\/v[^/]+/, '/vN');
  const rateLimitConfig = ctx.config.rateLimit;

  let realClientId, maskedClientId, rateLimiterConfigByAuthType;

  let maskingKey = await redis.get(MASKING_KEY);

  if (!maskingKey) {
    maskingKey = await changeMaskingKey();
  }

  if (ctx.state.authJWTPayload?.userId) {
    realClientId = ctx.state.authJWTPayload.userId;
    maskedClientId = `u-${maskClientId(realClientId, maskingKey)}`;
    rateLimiterConfigByAuthType = rateLimitConfig.authenticated;
  } else {
    realClientId = ctx.ip;
    maskedClientId = `a-${maskClientId(realClientId, maskingKey)}`;
    rateLimiterConfigByAuthType = rateLimitConfig.anonymous;
  }

  const requestTags = { method: requestMethod, auth: authTokenType, clientId: maskedClientId };
  monitor.increment('requests', 1, requestTags);

  debug(
    `${requestId}: ${requestMethod} ${ctx.request.originalUrl} request from ${realClientId} (${authTokenType})`,
  );

  if (rateLimitConfig.enabled) {
    if (rateLimitConfig.allowlist.includes(realClientId)) {
      debug(`${requestId}: Client allowlisted, request allowed`);
      // do nothing
    } else if (await isClientBlocked(realClientId)) {
      monitor.increment('requests-rate-limited', 1, requestTags);
      const blockTTL = await getClientBlockedDuration(realClientId);
      debug(`${requestId}: Client is already blocked, ${blockTTL} sec remaining, request denied`);

      throw new TooManyRequestsException('Slow down');
    } else {
      const route = `${requestMethod === 'HEAD' ? 'GET' : requestMethod} ${matchedAPIRoute}`;

      const { duration, maxRequests } = rateLimiterConfigByAuthType;
      const maxRequestsForMethod =
        maxRequests[route] ?? maxRequests[requestMethod] ?? maxRequests.all;
      const clientIdWithMethod = `${realClientId}${requestMethod}`;

      const limit = await rateLimiter.get({
        id: clientIdWithMethod,
        max: maxRequestsForMethod,
        duration: Duration.fromISO(duration).toMillis(),
      });

      debug(`${requestId}: Remaining requests: ${limit.remaining}, max ${limit.total}`);

      if (!limit.remaining) {
        monitor.increment('requests-rate-limited', 1, requestTags);

        // When a client breaches the threshold for the first time, we block them for
        // rateLimitConfig.blockDuration (1 minute by default) and set a "previous blocks counter" to "1" which
        // lives for rateLimitConfig.blockDuration + rateLimitConfig.repeatBlockCounterDuration (1 + 10
        // = 11 minutes by default). If the same client breaches the threshold again during
        // these 11 minutes, we block them for a longer time (using rateLimitConfig.repeatBlockMultiplier,
        // 2 x 1 = 2 minutes by default), increment the counter and set it for longer as well (2 x 1 + 10 = 12
        // minutes). With each subsequent breach the counter and the multiplier increment, so the block time grows
        // longer and longer (1, 2, 4, 6, 8 minutes...) and we remember about it for longer and longer (11, 12, 14,
        // 16, 18 minutes...). If a client behaves well during these 11/12/14... minutes then the counter expires
        // and all past breaches get forgotten and forgiven

        const baseBlockDuration = durationToSeconds(rateLimitConfig.blockDuration);
        const previousBlocksCount = await getRepeatBlocksCount(realClientId);
        const blockDurationMultiplier =
          previousBlocksCount * rateLimitConfig.repeatBlockMultiplier || 1;
        const blockDurationSeconds = baseBlockDuration * blockDurationMultiplier;

        setClientBlocked(realClientId, blockDurationSeconds);

        const baseRepeatBlockCounterDuration = durationToSeconds(
          rateLimitConfig.repeatBlockCounterDuration,
        );
        const repeatBlockCounterDuration = baseRepeatBlockCounterDuration + blockDurationSeconds;
        setRepeatBlocksCount(realClientId, previousBlocksCount + 1, repeatBlockCounterDuration);

        debug(
          `${requestId}: Client blocked for ${blockDurationSeconds} sec (previous blocks: ${previousBlocksCount}), request denied`,
        );

        throw new TooManyRequestsException('Slow down');
      } else {
        debug(`${requestId}: Request allowed`);
      }
    }
  } else {
    debug(`${requestId}: Rate limiter not enabled`);
  }

  const keyTTL = await redis.ttl(MASKING_KEY);

  if (keyTTL < maskingKeyRotationIntervalSeconds / 10) {
    await changeMaskingKey();
  }

  await next();
}
