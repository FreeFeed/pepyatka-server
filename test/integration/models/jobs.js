/* eslint-env node, mocha */
/* global $pg_database */
import { setTimeout } from 'timers/promises';

import unexpected from 'unexpected';
import unexpectedDate from 'unexpected-date';
import unexpectedSinon from 'unexpected-sinon';
import { spy } from 'sinon';
import { difference, sortBy } from 'lodash';

import cleanDB from '../../dbCleaner';
import { Job, dbAdapter, JobManager } from '../../../app/models';

const expect = unexpected.clone();
expect.use(unexpectedDate).use(unexpectedSinon);

describe('Jobs', () => {
  describe('Single job operations', () => {
    before(() => cleanDB($pg_database));

    it(`should create a job`, async () => {
      const [job, now] = await Promise.all([Job.create('job'), dbAdapter.now()]);
      expect(job, 'to satisfy', {
        name: 'job',
        payload: {},
        createdAt: expect.it('to be close to', now),
        unlockAt: expect.it('to be close to', now),
      });
    });

    it(`should delete a job`, async () => {
      const job = await Job.create('job');

      expect(await Job.getById(job.id), 'not to be null');
      await job.delete();
      expect(await Job.getById(job.id), 'to be null');
    });

    it(`should create a job with scalar payload`, async () => {
      const job = await Job.create('job', 42);
      expect(job, 'to satisfy', { name: 'job', payload: 42 });
    });

    it(`should create a job with object payload`, async () => {
      const job = await Job.create('job', { foo: 42 });
      expect(job, 'to satisfy', { name: 'job', payload: { foo: 42 } });
    });

    it(`should create a deferred job with integer offset`, async () => {
      const [job, now] = await Promise.all([
        Job.create('job', {}, { unlockAt: 100 }),
        dbAdapter.now(),
      ]);
      expect(job, 'to satisfy', {
        name: 'job',
        payload: {},
        createdAt: expect.it('to be close to', now),
        unlockAt: expect.it('to be close to', new Date(now.getTime() + 100 * 1000)),
      });
    });

    it(`should create a deferred job with float offset`, async () => {
      const [job, now] = await Promise.all([
        Job.create('job', {}, { unlockAt: 100.45 }),
        dbAdapter.now(),
      ]);
      expect(job, 'to satisfy', {
        name: 'job',
        payload: {},
        createdAt: expect.it('to be close to', now),
        unlockAt: expect.it('to be close to', new Date(now.getTime() + 100.45 * 1000)),
      });
    });

    it(`should create a deferred job with exact Date`, async () => {
      const unlockAt = new Date(Date.now() + 12345000);
      const [job, now] = await Promise.all([Job.create('job', {}, { unlockAt }), dbAdapter.now()]);
      expect(job, 'to satisfy', {
        name: 'job',
        payload: {},
        createdAt: expect.it('to be close to', now),
        unlockAt: expect.it('to be close to', unlockAt),
      });
    });

    it(`should update unlock time a job after creation`, async () => {
      const [job, now] = await Promise.all([Job.create('job'), dbAdapter.now()]);
      expect(job, 'to satisfy', { unlockAt: expect.it('to be close to', now) });
      await job.setUnlockAt(100);
      expect(job, 'to satisfy', {
        unlockAt: expect.it('to be close to', new Date(now.getTime() + 100 * 1000)),
      });
    });
  });

  describe('Jobs with unique keys', () => {
    before(() => cleanDB($pg_database));

    it(`should create multiple jobs with the same name and without keys`, async () => {
      const [job1, job2] = await Promise.all([Job.create('job'), Job.create('job')]);
      expect(job1, 'not to be null');
      expect(job2, 'not to be null');
      expect(job1.id, 'not to be', job2.id);

      await job1.delete();
      await job2.delete();
    });

    it(`should update existing job with same key`, async () => {
      const job1 = await Job.create('job', 42, { unlockAt: 100, uniqKey: 'key' });
      const [job2, now] = await Promise.all([
        Job.create('job', 43, { unlockAt: 200, uniqKey: 'key' }),
        dbAdapter.now(),
      ]);
      expect(job2, 'to satisfy', {
        id: job1.id,
        payload: 43,
        unlockAt: expect.it('to be close to', new Date(now.getTime() + 200 * 1000)),
      });
    });
  });

  describe('Job manager', () => {
    beforeEach(() => cleanDB($pg_database));

    let jm;
    beforeEach(() => (jm = new JobManager()));

    it('should not fetch jobs from empty queue', async () => {
      const jobs = await jm.fetch();
      expect(jobs, 'to be empty');
    });

    it('should fetch placed jobs', async () => {
      const [job1, now] = await Promise.all([Job.create('job'), dbAdapter.now()]);
      await setTimeout(10);
      const job2 = await Job.create('job');
      const jobs = await jm.fetch();

      expect(sortBy(jobs, 'createdAt'), 'to satisfy', [
        {
          id: job1.id,
          unlockAt: expect.it('to be close to', new Date(now.getTime() + jm.jobLockTime * 1000)),
        },
        {
          id: job2.id,
          unlockAt: expect.it('to be close to', new Date(now.getTime() + jm.jobLockTime * 1000)),
        },
      ]);
    });

    it('should fetch placed job only once', async () => {
      const job = await Job.create('job');

      {
        const jobs = await jm.fetch();
        expect(jobs, 'to satisfy', [{ id: job.id }]);
      }

      {
        const jobs = await jm.fetch();
        expect(jobs, 'to be empty');
      }
    });

    it('should fetch placed job again after the timeout', async () => {
      const job = await Job.create('job');

      {
        const jobs = await jm.fetch();
        expect(jobs, 'to satisfy', [{ id: job.id }]);
      }

      // Manually reset the job lock time to 'now'
      await job.setUnlockAt(0);

      {
        const jobs = await jm.fetch();
        expect(jobs, 'to satisfy', [{ id: job.id }]);
      }
    });

    describe('Job processing', () => {
      it(`should not allow to assign two job handlers`, () => {
        jm.on('job', () => null);
        expect(() => jm.on('job', () => null), 'to throw');
      });

      it(`should fetch and process jobs`, async () => {
        const spy1 = spy();
        const spy2 = spy();
        jm.on('job1', spy1);
        jm.on('job2', spy2);

        const job1 = await Job.create('job1');
        await setTimeout(10);
        const job2 = await Job.create('job2');

        await jm.fetchAndProcess();

        expect(spy1, 'to have a call satisfying', [{ id: job1.id }]);
        expect(spy2, 'to have a call satisfying', [{ id: job2.id }]);

        // Jobs should be deleted
        expect(await Job.getById(job1.id), 'to be null');
        expect(await Job.getById(job2.id), 'to be null');
      });

      it(`should not delete job when handler calls 'keep'`, async () => {
        const spy1 = spy((job) => job.keep());
        jm.on('job1', spy1);

        const job1 = await Job.create('job1');

        await jm.fetchAndProcess();

        expect(spy1, 'to have a call satisfying', [{ id: job1.id }]);

        expect(await Job.getById(job1.id), 'not to be null');
      });

      it(`should not delete job when handler throws exception`, async () => {
        const spy1 = spy(() => {
          throw new Error('Error!');
        });
        jm.on('job1', spy1);

        const job1 = await Job.create('job1');

        await jm.fetchAndProcess();

        expect(spy1, 'to have a call satisfying', [{ id: job1.id }]);

        expect(await Job.getById(job1.id), 'not to be null');
      });

      it(`should re-lock job if it have no handler`, async () => {
        const [job, now] = await Promise.all([Job.create('job'), dbAdapter.now()]);

        const [job1] = await jm.fetchAndProcess();

        expect(job1, 'to satisfy', {
          id: job.id,
          attempts: 1,
          failures: 1,
          unlockAt: expect.it('to be close to', new Date(now.getTime() + jm.jobLockTime * 1000)),
        });
      });

      it(`should extend unlock time for failed job`, async () => {
        const job = await Job.create('job');
        await jm.fetchAndProcess();
        await dbAdapter.database.raw(`update jobs set unlock_at = now() where id = ?`, job.id);
        const [[job1], now] = await Promise.all([jm.fetchAndProcess(), dbAdapter.now()]);

        expect(job1, 'to satisfy', {
          id: job.id,
          attempts: 2,
          failures: 2,
          unlockAt: expect.it(
            'to be close to',
            new Date(now.getTime() + jm.jobLockTime * jm.jobLockTimeMultiplier * 1000),
          ),
        });
      });

      describe(`Middlewares`, () => {
        it(`should wrap handler by middlewares`, async () => {
          const calls = [];

          jm.use((handler) => async (job) => {
            calls.push(`m1-before(${job.name})`);
            await handler(job);
            calls.push(`m1-after(${job.name})`);
          });
          jm.use((handler) => async (job) => {
            calls.push(`m2-before(${job.name})`);
            await handler(job);
            calls.push(`m2-after(${job.name})`);
          });

          jm.on('job', (job) => calls.push(`handler(${job.name})`));

          await Job.create('job');
          await jm.fetchAndProcess();

          expect(calls, 'to equal', [
            'm2-before(job)',
            'm1-before(job)',
            'handler(job)',
            'm1-after(job)',
            'm2-after(job)',
          ]);
        });

        it(`should handle exceptions in middlewares`, async () => {
          const calls = [];

          jm.use((handler) => async (job) => {
            try {
              calls.push(`m1-before(${job.name})`);
              await handler(job);
              calls.push(`m1-after(${job.name})`);
            } catch (e) {
              calls.push(`m1-exception(${job.name}, ${e.message})`);
              throw e;
            }
          });
          jm.use((handler) => async (job) => {
            calls.push(`m2-before(${job.name})`);
            await handler(job);
            calls.push(`m2-after(${job.name})`);
          });

          // No handler for 'job'

          await Job.create('job');
          await jm.fetchAndProcess();

          expect(calls, 'to equal', [
            'm2-before(job)',
            'm1-before(job)',
            `m1-exception(job, handler is not registered for 'job')`,
          ]);
        });
      });
    });
  });

  describe('Limited jobs', () => {
    beforeEach(() => cleanDB($pg_database));

    it(`should fetch only one job of type 'foo'`, async () => {
      const jm = new JobManager({ limitedJobs: { foo: 1 } });
      const job1 = await Job.create('foo');
      const job2 = await Job.create('foo');

      {
        const jobs = await jm.fetch();
        expect(jobs, 'to have length', 1);
        expect(jobs[0].id, 'to be', job1.id);
      }

      {
        const jobs = await jm.fetch();
        expect(jobs, 'to have length', 0);
      }

      await job1.delete();

      {
        const jobs = await jm.fetch();
        expect(jobs, 'to have length', 1);
        expect(jobs[0].id, 'to be', job2.id);
      }
    });

    it(`should emulate a processing of limited jobs`, async () => {
      const jm = new JobManager({ limitedJobs: { foo: 2 } });
      let resolve;
      const promise = new Promise((_resolve) => (resolve = _resolve));

      jm.on('foo', () => promise);

      const jobs = [
        // Three jobs of type 'foo'
        await Job.create('foo'),
        await Job.create('foo'),
        await Job.create('foo'),
      ];

      const allIds = jobs.map((j) => j.id);

      let [pj] = await Promise.all([jm.fetchAndProcess(), setTimeout(50).then(resolve)]);
      const fetchedIds = pj.map((j) => j.id);

      expect(fetchedIds, 'to have length', 2);

      pj = await jm.fetchAndProcess();
      expect(
        pj.map((j) => j.id),
        'to equal',
        difference(allIds, fetchedIds),
      );
    });

    it('should respect different limits for different job types', async () => {
      const jm = new JobManager({ limitedJobs: { foo: 1, bar: 2 } });
      await Promise.all([
        Job.create('foo'),
        Job.create('foo'),
        Job.create('bar'),
        Job.create('bar'),
        Job.create('bar'),
      ]);

      const jobs = await jm.fetch();
      expect(jobs, 'to have length', 3);
      expect(
        jobs.filter((j) => j.name === 'foo'),
        'to have length',
        1,
      );
      expect(
        jobs.filter((j) => j.name === 'bar'),
        'to have length',
        2,
      );
    });

    it('should respect unlock_at ordering', async () => {
      const jm = new JobManager({ limitedJobs: { foo: 1 } });
      const foo1 = await Job.create('foo');
      await setTimeout(100);
      await Job.create('foo');

      const jobs = await jm.fetch();
      expect(jobs, 'to have length', 1);
      expect(jobs[0].id, 'to be', foo1.id);
    });

    it('should handle concurrent fetches correctly', async () => {
      const jm1 = new JobManager({ limitedJobs: { foo: 2 } });
      const jm2 = new JobManager({ limitedJobs: { foo: 2 } });

      await Promise.all([
        Job.create('foo'),
        Job.create('foo'),
        Job.create('foo'),
        Job.create('foo'),
      ]);

      const [batch1, batch2] = await Promise.all([jm1.fetch(), jm2.fetch()]);

      expect(batch1.length + batch2.length, 'to be', 2);
      const allIds = [...batch1, ...batch2].map((j) => j.id);
      expect(allIds, 'to have length', 2);
      expect(new Set(allIds).size, 'to be', 2); // all ids should be unique
    });

    it('should correctly handle mix of limited and unlimited jobs', async () => {
      const jm = new JobManager({ batchSize: 4, limitedJobs: { foo: 1, bar: 2 } });

      await Promise.all([
        Job.create('foo'),
        Job.create('foo'),
        Job.create('bar'),
        Job.create('bar'),
        Job.create('unlimited'),
        Job.create('unlimited'),
      ]);

      const fetched = await jm.fetch();
      expect(fetched, 'to have length', 4);
      expect(
        fetched.filter((j) => j.name === 'foo'),
        'to have length',
        1,
      );
      expect(
        fetched.filter((j) => j.name === 'bar'),
        'to have length',
        2,
      );
      expect(
        fetched.filter((j) => j.name === 'unlimited'),
        'to have length',
        1,
      );
    });

    it('should count currently locked jobs towards limits', async () => {
      const jm1 = new JobManager({ limitedJobs: { foo: 2 } });
      const jm2 = new JobManager({ limitedJobs: { foo: 2 } });

      await Promise.all([Job.create('foo'), Job.create('foo'), Job.create('foo')]);

      const batch1 = await jm1.fetch();
      expect(batch1, 'to have length', 2);

      const batch2 = await jm2.fetch();
      expect(batch2, 'to have length', 0);
    });

    it('should respect count parameter regardless of limits', async () => {
      const jm = new JobManager({ limitedJobs: { foo: 5, bar: 5 } });

      await Promise.all([
        Job.create('foo'),
        Job.create('foo'),
        Job.create('bar'),
        Job.create('bar'),
        Job.create('unlimited'),
      ]);

      const jobs = await jm.fetch(2); // fetch only 2 jobs
      expect(jobs, 'to have length', 2);
    });

    it('should handle rapid sequential fetches correctly', async () => {
      const jm = new JobManager({ limitedJobs: { foo: 2 } });

      // Create 4 jobs
      await Promise.all([
        Job.create('foo'),
        Job.create('foo'),
        Job.create('foo'),
        Job.create('foo'),
      ]);

      // Rapid sequential fetches without waiting for the first one to complete
      const [batch1, batch2, batch3] = await Promise.all([jm.fetch(), jm.fetch(), jm.fetch()]);

      // We should get exactly 2 jobs in total (limit: 2)
      expect(batch1.length + batch2.length + batch3.length, 'to be', 2);

      // All received jobs should be unique
      const allIds = [...batch1, ...batch2, ...batch3].map((j) => j.id);
      expect(new Set(allIds).size, 'to be', 2);
    });
  });
});
