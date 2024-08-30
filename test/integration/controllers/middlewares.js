/* eslint-env node, mocha */
/* global $pg_database */
import compose from 'koa-compose';
import unexpected from 'unexpected';
import unexpectedSinon from 'unexpected-sinon';
import { noop } from 'lodash';
import { spy, stub } from 'sinon';

import cleanDB from '../../dbCleaner';
import { inputSchemaRequired, monitored } from '../../../app/controllers/middlewares';

const expect = unexpected.clone();
expect.use(unexpectedSinon);

describe('Controller middlewares', () => {
  beforeEach(() => cleanDB($pg_database));

  describe('inputSchemaRequired', () => {
    const schema = {
      $schema: 'http://json-schema.org/schema#',
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string', default: 'boo' },
      },
    };

    const handler = (ctx) => inputSchemaRequired(schema)(ctx, noop);
    const ctx = { request: { body: {} } };

    it('should pass the valid request data', async () => {
      ctx.request.body = { a: 'aaa' };
      await expect(handler(ctx), 'to be fulfilled');
    });

    it('should not pass request data without required field', async () => {
      ctx.request.body = { b: 'bbb' };
      await expect(handler(ctx), 'to be rejected with', { status: 422 });
    });

    it('should not pass the invalid request data', async () => {
      ctx.request.body = { a: 'aaa', b: 223 };
      await expect(handler(ctx), 'to be rejected with', { status: 422 });
    });

    it('should complete request data with the defaults', async () => {
      ctx.request.body = { a: 'aaa' };
      await handler(ctx);
      expect(ctx.request.body, 'to equal', { a: 'aaa', b: 'boo' });
    });
  });

  describe('monitored', () => {
    const timer = { stop: spy() };
    const monitor = {
      increment: spy(),
      timer: stub().returns(timer),
    };

    const handler = compose([monitored('test', {}, monitor)]);
    const failHandler = compose([
      monitored('test', {}, monitor),
      () => {
        throw new Error('');
      },
    ]);
    const nestedHandler = compose([
      monitored('test1', {}, monitor),
      monitored('test', {}, monitor),
    ]);

    let ctx;
    beforeEach(() => {
      [monitor.increment, monitor.timer, timer.stop].forEach((theSpy) => theSpy.resetHistory());
      ctx = { state: {} };
    });

    it(`should increment 'test-requests' counter after successiful call`, async () => {
      await handler(ctx);
      expect(monitor.increment, 'to have a call satisfying', [
        'test-requests',
        1,
        { auth: 'anonymous' },
      ]);
    });

    it(`should not increment 'test-requests' counter after failed call`, async () => {
      try {
        await failHandler(ctx);
      } catch {
        // pass
      }

      expect(monitor.increment, 'was not called');
    });

    it(`should start and stop 'test-time' timer`, async () => {
      await handler(ctx);
      expect(monitor.timer, 'to have a call satisfying', ['test-time', true, {}]);
      expect(timer.stop, 'was called');
      expect([monitor.timer, timer.stop], 'given call order');
    });

    it(`should clear ctx.state.isMonitored flag`, async () => {
      await handler(ctx);
      expect(ctx.state, 'to not have key', 'isMonitored');
    });

    it(`should not call monitor methods in nested call`, async () => {
      await nestedHandler(ctx);
      expect(monitor.increment, 'to have a call satisfying', [
        'test1-requests',
        1,
        { auth: 'anonymous' },
      ]);
      expect(monitor.timer, 'to have a call satisfying', ['test1-time', true, {}]);
      expect(monitor.increment, 'was called once');
      expect(monitor.timer, 'was called once');
      expect(timer.stop, 'was called once');
    });

    it(`should use custom counter and timer names`, async () => {
      await monitored({ timer: 'timerA', requests: 'requestsB' }, {}, monitor)(ctx, noop);
      expect(monitor.timer, 'to have a call satisfying', ['timerA', true, {}]);
      expect(monitor.increment, 'to have a call satisfying', [
        'requestsB',
        1,
        { auth: 'anonymous' },
      ]);
    });
  });
});
