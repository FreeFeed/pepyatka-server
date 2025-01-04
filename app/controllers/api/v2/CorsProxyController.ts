import { Readable } from 'stream';
import { ReadableStream } from 'stream/web';

import { Context } from 'koa';
import { Duration } from 'luxon';

import { ForbiddenException, ValidationException } from '../../../support/exceptions';
import { currentConfig } from '../../../support/app-async-context';

const fallbackTimeoutMs = 1000;

export async function proxy(ctx: Context) {
  const {
    timeout: timeoutString,
    allowedOrigins,
    allowedURlPrefixes,
    allowLocalhostOrigins,
  } = currentConfig().corsProxy;

  const { origin } = ctx.headers;

  if (typeof origin !== 'string') {
    // If the client is hosted at the same origin as the server, the browser
    // will not send the Origin header. The 'none' value is used to allow these
    // types of requests.
    if (!allowedOrigins.includes('none')) {
      throw new ForbiddenException('Missing origin');
    }
  } else if (
    // Origin header is present, check it validity
    !(
      allowedOrigins.includes(origin) ||
      (allowLocalhostOrigins && /^https?:\/localhost(:\d+)?$/.test(origin))
    )
  ) {
    throw new ForbiddenException('Origin not allowed');
  }

  let { url } = ctx.request.query;

  if (Array.isArray(url)) {
    // When there is more than one 'url' parameter, use the first one
    [url] = url;
  }

  if (typeof url !== 'string') {
    throw new ValidationException("Missing 'url' parameter");
  }

  // Check if the URL has allowed prefix
  if (!allowedURlPrefixes.some((prefix) => url.startsWith(prefix))) {
    throw new ValidationException('URL not allowed');
  }

  const timeoutDuration = Duration.fromISO(timeoutString);
  const timeoutMs = timeoutDuration.isValid ? timeoutDuration.toMillis() : fallbackTimeoutMs;

  // Perform the request with timeout
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

  // Copying to the client:
  // 1. The response status code
  ctx.status = response.status;

  // 2. Some of response headers that we want to pass to the client
  for (const header of ['Location', 'Content-Type', 'Content-Length']) {
    if (response.headers.has(header)) {
      ctx.set(header, response.headers.get(header)!);
    }
  }

  // 3. And the response body itself
  ctx.body = response.body ? Readable.fromWeb(response.body as ReadableStream) : null;
}
