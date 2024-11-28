import createDebug from 'debug';
import Raven from 'raven';
import config from 'config';

const sentryIsEnabled = 'sentryDsn' in config;
const debug = createDebug('freefeed:jobs:debug');
const debugVerbose = createDebug('freefeed:jobs:verbose');
const debugError = createDebug('freefeed:jobs:errors');

const KEPT = Symbol('KEEP');

export function addJobModel(dbAdapter) {
  return class Job {
    id;
    createdAt;
    unlockAt;
    name;
    payload;
    attempts;
    failures;
    uniqKey;
    [KEPT] = false;

    constructor(params) {
      for (const f of Object.keys(this)) {
        if (f in params) {
          this[f] = params[f];
        }
      }
    }

    /**
     * Create and place a new job. If the job with the given name and unique key
     * already exists, return it with updated payload and unlock time.
     *
     * @param {string} name
     * @param {any} payload
     * @param {object} params
     * @returns {Promise<Job>}
     */
    static create(name, payload = {}, { unlockAt = 0, uniqKey = null } = {}) {
      _checkUnlockAtType(unlockAt);
      return dbAdapter.createJob(name, payload, { unlockAt, uniqKey });
    }

    static getById(id) {
      return dbAdapter.getJobById(id);
    }

    /**
     * @param {Date | number} [unlockAt]
     * @param {boolean | null} [failure] - increment failures counter if true, reset it if false
     * @returns {Promise<void>}
     */
    async setUnlockAt(unlockAt = 0, failure = null) {
      _checkUnlockAtType(unlockAt);
      const modified = await dbAdapter.updateJob(this.id, { unlockAt, failure });
      this.unlockAt = modified.unlockAt;
      this.failures = modified.failures;
    }

    async keep(unlockAt = 0) {
      await this.setUnlockAt(unlockAt, false);
      this[KEPT] = true;
    }

    get kept() {
      return this[KEPT];
    }

    /**
     * Delete job. The JobManager calls this method automatically when the job
     * is processed without errors. To keep job alive, call job.keep() at the
     * end of the job handler.
     * @returns {Promise<void>}
     */
    delete() {
      return dbAdapter.deleteJob(this.id);
    }
  };
}

export function addJobManagerModel(dbAdapter) {
  return class JobManager {
    pollInterval;
    jobLockTime;
    maxJobLockTime;
    jobLockTimeMultiplier;
    batchSize;
    limitedJobs = {};

    _pollTimer = null;
    _handlers = new Map();

    /**
     * @param {Partial<typeof config.jobManager & {limitedJobs: Record<string, number>}>} [props]
     */
    constructor(props = {}) {
      props = { ...config.jobManager, limitedJobs: {}, ...props };
      this.pollInterval = props.pollInterval;
      this.jobLockTime = props.jobLockTime;
      this.maxJobLockTime = props.maxJobLockTime;
      this.jobLockTimeMultiplier = props.jobLockTimeMultiplier;
      this.batchSize = props.batchSize;
      this.limitedJobs = props.limitedJobs;
    }

    /**
     * Middleware is function that takes the job handler and returns a modified
     * job handler. The no-op middleware looks like (handler) => (job) =>
     * handler(job).
     *
     * Handler can return some value which may be useful for other middlewares,
     * so the polite middleware should also return this value.
     *
     * If middleware handles job exceptions, it should re-throw them for the
     * proper job error handling. "Eat" exception only if you intend to mark job
     * as successfully completed.
     *
     * @param {Function} mw
     */
    use(mw) {
      const prev = this._getHandler;
      this._getHandler = (handler) => mw(prev(handler));
    }

    // The root middleware just selects proper handler
    _getHandler = () => (job) => (this._handlers.get(job.name) || noHandler)(job);

    startPolling() {
      debug('starting polling');
      this._pollTimer = setInterval(
        () =>
          this.fetchAndProcess().catch((err) => {
            debugError('cannot fetch jobs', err);

            if (sentryIsEnabled) {
              Raven.captureException(err, { extra: { err: `cannot fetch jobs: ${err.message}` } });
            }
          }),
        this.pollInterval * 1000,
      );
    }

    stopPolling() {
      debug('stopping polling');
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    /**
     * Fetch jobs from the queue.
     *
     * @param {number} count
     * @param {number} lockTime
     * @returns {Promise<Job[]>}
     */
    async fetch(count = this.batchSize, lockTime = this.jobLockTime) {
      debugVerbose('fetching jobs');
      const jobs = await dbAdapter.fetchJobs(count, lockTime, this.limitedJobs);
      debugVerbose(`${jobs.length} jobs found`);
      return jobs;
    }

    /**
     * Fetch and process jobs. This method will not fail if any job fail, all
     * exceptions should be handled in middlewares.
     *
     * @param {number} count
     * @param {number} lockTime
     * @returns {Promise<Job[]>}
     */
    async fetchAndProcess(count = this.batchSize, lockTime = this.jobLockTime) {
      const jobs = await this.fetch(count, lockTime);
      // Wait for all handlers
      await Promise.allSettled(jobs.map(this._process));
      return jobs;
    }

    /**
     * Set the main handler for the jobs with the given name
     *
     * Any name can (and should) have only one main handler. If job handler
     * hasn't been set, the job process failed.
     *
     * @param {string} name
     * @param {Function} handler
     */
    on(name, handler) {
      if (this._handlers.has(name)) {
        // Only one handler per name is allowed
        debugError(`attempt to add a second handler for '${name}' jobs`);
        throw new Error(`attempt to add a second handler for '${name}' jobs`);
      }

      this._handlers.set(name, handler);

      // Return unsubscribe function
      return () => this._handlers.delete(name);
    }

    _process = async (job) => {
      try {
        debug(`processing job ${job.name} (${job.id})`);
        await this._getHandler()(job);

        if (!job.kept) {
          debug(`deleting job ${job.name} (${job.id})`);
          await job.delete();
        } else {
          debug(`job is left in queue ${job.name} (${job.id})`);
        }
      } catch (err) {
        debugError(`error processing job ${job.name} (${job.id})`, err, job);

        if (sentryIsEnabled) {
          Raven.captureException(err, { extra: { err: `error processing job '${job.name}'` } });
        }

        await job.setUnlockAt(
          Math.min(
            this.jobLockTime * this.jobLockTimeMultiplier ** job.failures,
            this.maxJobLockTime,
          ),
          true,
        );
      }
    };
  };
}

/**
 * @param {Date | number} unlockAt
 *
 * unlockAt can be:
 * - Date object (will be interpreted as a DB server time)
 * - number (of seconds from now)
 */
function _checkUnlockAtType(unlockAt) {
  if (!(unlockAt instanceof Date) && !Number.isFinite(unlockAt)) {
    throw new Error('Invalid type of unlockAt parameter');
  }
}

function noHandler(job) {
  throw new Error(`handler is not registered for '${job.name}'`);
}
