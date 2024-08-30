import { pick, difference } from 'lodash';
import compose from 'koa-compose';
import { DateTime } from 'luxon';
import config from 'config';

import { authRequired, monitored, inputSchemaRequired } from '../../middlewares';
import { AppTokenV1, dbAdapter } from '../../../models';
import {
  ValidationException,
  NotFoundException,
  BadRequestException,
} from '../../../support/exceptions';
import { appTokensScopes } from '../../../models/auth-tokens/app-tokens-scopes';
import { Address } from '../../../support/ipv6';

import {
  appTokenCreateInputSchema,
  appTokenUpdateInputSchema,
  appTokenActivateInputSchema,
} from './data-schemes/app-tokens';

export const create = compose([
  authRequired(),
  inputSchemaRequired(appTokenCreateInputSchema),
  monitored('app-tokens.create'),
  async (ctx) => {
    const {
      state: { user },
      request: { body },
    } = ctx;

    const validScopes = appTokensScopes.map(({ name }) => name);
    const unknownScopes = difference(body.scopes, validScopes);

    if (unknownScopes.length > 0) {
      throw new ValidationException(`Unknown scopes: ${unknownScopes.join(', ')}`);
    }

    const invalidNetmasks = body.restrictions.netmasks.filter((mask) => {
      try {
        new Address(mask);
        return false;
      } catch {
        return true;
      }
    });

    if (invalidNetmasks.length > 0) {
      throw new ValidationException(`Invalid netmasks: ${invalidNetmasks.join(', ')}`);
    }

    const invalidOrigins = body.restrictions.origins.filter((o) => !/^https?:\/\/[^/]+$/.test(o));

    if (invalidOrigins.length > 0) {
      throw new ValidationException(`Invalid origins: ${invalidOrigins.join(', ')}`);
    }

    let expiresAt = undefined;
    let expiresAtSeconds = undefined;

    if (typeof body.expiresAt === 'number') {
      expiresAtSeconds = body.expiresAt;
    } else if (typeof body.expiresAt === 'string') {
      expiresAt = DateTime.fromISO(body.expiresAt, { zone: config.ianaTimeZone }).toJSDate();

      if (!expiresAt || isNaN(expiresAt)) {
        throw new ValidationException(`Invalid ISO 8601 date string: ${body.expiresAt}`);
      }
    }

    const token = await dbAdapter.createAppToken({
      userId: user.id,
      title: body.title,
      scopes: body.scopes,
      restrictions: body.restrictions,
      expiresAt,
      expiresAtSeconds,
    });

    ctx.body = {
      token: serializeAppToken(token),
      tokenString: token.tokenString(),
      activationCode: token.activationCode,
      activationCodeTTL: config.appTokens.activationCodeTTL,
    };
  },
]);

export const inactivate = compose([
  authRequired(),
  monitored('app-tokens.inactivate'),
  async (ctx) => {
    const { user } = ctx.state;
    const token = await dbAdapter.getAppTokenById(ctx.params.tokenId);

    if (!token || token.userId !== user.id) {
      throw new NotFoundException('Token not found');
    }

    await token.inactivate();

    ctx.body = {};
  },
]);

export const reissue = compose([
  authRequired(),
  monitored('app-tokens.reissue'),
  async (ctx) => {
    const { user } = ctx.state;
    const token = await dbAdapter.getAppTokenById(ctx.params.tokenId);

    if (!token || token.userId !== user.id || !token.isActive) {
      throw new NotFoundException('Token not found');
    }

    await token.reissue();

    ctx.body = {
      token: serializeAppToken(token),
      tokenString: token.tokenString(),
      activationCode: token.activationCode,
      activationCodeTTL: config.appTokens.activationCodeTTL,
    };
  },
]);

export const reissueCurrent = compose([
  authRequired(),
  monitored('app-tokens.reissue-current'),
  async (ctx) => {
    const { authToken: token } = ctx.state;

    if (!(token instanceof AppTokenV1)) {
      throw new BadRequestException('This method is only available with the application token');
    }

    await token.reissue();

    ctx.body = {
      token: serializeAppToken(token, true),
      tokenString: token.tokenString(),
    };
  },
]);

export const update = compose([
  authRequired(),
  inputSchemaRequired(appTokenUpdateInputSchema),
  monitored('app-tokens.update'),
  async (ctx) => {
    const {
      state: { user },
      request: {
        body: { title },
      },
    } = ctx;
    const token = await dbAdapter.getAppTokenById(ctx.params.tokenId);

    if (!token || token.userId !== user.id || !token.isActive) {
      throw new NotFoundException('Token not found');
    }

    await token.setTitle(title);

    ctx.body = { token: serializeAppToken(token) };
  },
]);

export const list = compose([
  authRequired(),
  monitored('app-tokens.update'),
  async (ctx) => {
    const {
      state: { user },
    } = ctx;

    const tokens = await dbAdapter.listActiveAppTokens(user.id);

    ctx.body = { tokens: tokens.map((t) => serializeAppToken(t)) };
  },
]);

export const scopes = (ctx) => (ctx.body = { scopes: appTokensScopes });

export const current = compose([
  authRequired(),
  monitored('app-tokens.current'),
  (ctx) => {
    const { authToken: token } = ctx.state;

    if (!(token instanceof AppTokenV1)) {
      throw new BadRequestException('This method is only available with the application token');
    }

    ctx.body = { token: serializeAppToken(token, true) };
  },
]);

export const activate = compose([
  inputSchemaRequired(appTokenActivateInputSchema),
  monitored('app-tokens.activate'),
  async (ctx) => {
    const { activationCode: rawActivationCode } = ctx.request.body;
    const activationCode = AppTokenV1.normalizeActivationCode(rawActivationCode);

    if (activationCode === null) {
      throw new ValidationException(`Invalid activation code, check that you entered it correctly`);
    }

    const token = await dbAdapter.getAppTokenByActivationCode(
      activationCode,
      config.appTokens.activationCodeTTL,
    );

    if (!token) {
      throw new NotFoundException('Unknown or expired activation code');
    }

    try {
      token.checkRestrictions(ctx);
    } catch {
      throw new NotFoundException('Unknown or expired activation code');
    }

    await token.reissue();

    ctx.body = {
      token: serializeAppToken(token, true),
      tokenString: token.tokenString(),
    };
  },
]);

function serializeAppToken(token, restricted = false) {
  return pick(token, [
    'id',
    restricted || 'title',
    'issue',
    'createdAt',
    'updatedAt',
    'expiresAt',
    'scopes',
    'restrictions',
    restricted || 'lastUsedAt',
    restricted || 'lastIP',
    restricted || 'lastUserAgent',
  ]);
}
