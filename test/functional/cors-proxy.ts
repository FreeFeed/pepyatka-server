import { after, before, describe, it } from 'mocha';
import expect from 'unexpected';
import { Context } from 'koa';

import { withModifiedConfig } from '../helpers/with-modified-config';

import { performJSONRequest, MockHTTPServer } from './functional_test_helper';

const server = new MockHTTPServer((ctx: Context) => {
  const {
    request: { url },
  } = ctx;

  if (url === '/example.txt') {
    ctx.status = 200;
    ctx.response.type = 'text/plain';
    ctx.body = 'Example text';
  } else {
    ctx.status = 404;
    ctx.response.type = 'text/plain';
    ctx.body = 'Not found';
  }
});

describe('CORS proxy', () => {
  before(() => server.start());
  after(() => server.stop());

  withModifiedConfig(() => ({
    corsProxy: {
      allowedOrigins: ['none', 'http://goodorigin.net'],
      allowedURlPrefixes: [`${server.origin}/example`],
    },
  }));

  it(`should return error if called without url`, async () => {
    const resp = await performJSONRequest('GET', '/v2/cors-proxy');
    expect(resp, 'to equal', { __httpCode: 422, err: "Missing 'url' parameter" });
  });

  it(`should return error if called with not allowed url`, async () => {
    const url = `${server.origin}/index.html`;
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to equal', { __httpCode: 422, err: 'URL not allowed' });
  });

  it(`should return error if called with invalid origin`, async () => {
    const url = `${server.origin}/example.txt`;
    const resp = await performJSONRequest(
      'GET',
      `/v2/cors-proxy?url=${encodeURIComponent(url)}`,
      null,
      { Origin: 'https://badorigin.net' },
    );
    expect(resp, 'to equal', { __httpCode: 403, err: 'Origin not allowed' });
  });

  it(`should call with allowed url and without origin`, async () => {
    const url = `${server.origin}/example.txt`;
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to satisfy', { __httpCode: 200, textResponse: 'Example text' });
  });

  it(`should call with allowed (but non-existing) url and without origin`, async () => {
    const url = `${server.origin}/example.pdf`;
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to satisfy', { __httpCode: 404, textResponse: 'Not found' });
  });

  it(`should call with allowed url and origin`, async () => {
    const url = `${server.origin}/example.txt`;
    const resp = await performJSONRequest(
      'GET',
      `/v2/cors-proxy?url=${encodeURIComponent(url)}`,
      null,
      { Origin: 'http://goodorigin.net' },
    );
    expect(resp, 'to satisfy', { __httpCode: 200, textResponse: 'Example text' });
  });

  it(`should call with allowed url and localhost origin`, async () => {
    const url = `${server.origin}/example.txt`;
    const resp = await performJSONRequest(
      'GET',
      `/v2/cors-proxy?url=${encodeURIComponent(url)}`,
      null,
      { Origin: 'http://localhost:8080' },
    );
    expect(resp, 'to satisfy', { __httpCode: 200, textResponse: 'Example text' });
  });
});
