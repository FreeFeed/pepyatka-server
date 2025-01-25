/* eslint babel/semi: "error" */
import createDebug from 'debug';
import Raven from 'raven';
import config from 'config';

const debug = createDebug('freefeed:errors');

const sentryIsEnabled = 'sentryDsn' in config;

export function reportError(ctx) {
  return (err) => {
    const status = err?.status || 500;

    debug(err);

    if (status === 500 && sentryIsEnabled) {
      Raven.captureException(err, { req: ctx.request });
    }

    if (
      ('internalQuery' in err || err.message.includes('when compiling RAW query')) &&
      process.env.NODE_ENV !== 'test'
    ) {
      // looks like postgres err
      err = { message: 'Database-related internal error' }; // do not expose DB internals
    }

    ctx.status = status;
    ctx.body = { err: err?.message || 'Internal Server Error' };
  };
}

export class BadRequestException extends Error {
  constructor(message = 'Bad Request') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 400;
  }
}

export class NotAuthorizedException extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 401;
  }
}

export class ForbiddenException extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 403;
  }
}

export class NotFoundException extends Error {
  constructor(message = 'Not found') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 404;
  }
}

export class ValidationException extends Error {
  constructor(message = 'Invalid') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 422;
  }
}

export class TooManyRequestsException extends Error {
  constructor(message = 'Too Many Requests') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 429;
  }
}

export class ContentTooLargeException extends Error {
  constructor(message = 'Content Too Large') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 413;
  }
}

export class ServerErrorException {
  constructor(message) {
    this.message = message || 'Internal server error';
    this.status = 500;
  }
}
