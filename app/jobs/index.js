import monitor from 'monitor-dog';
import Raven from 'raven';
import config from 'config';

import { JobManager } from '../models';

import { initHandlers as initPeriodicHandlers } from './periodic';
import { initHandlers as initUserGoneHandlers } from './user-gone';
import { initHandlers as initAttachmentsSanitizeHandlers } from './attachments-sanitize';
import { initHandlers as initAttachmentPrepareVideoHandlers } from './attachment-prepare-video';

export async function initJobProcessing(app) {
  const jobManager = new JobManager(config.jobManager);
  await Promise.all(
    [
      initPeriodicHandlers,
      initUserGoneHandlers,
      initAttachmentsSanitizeHandlers,
      initAttachmentPrepareVideoHandlers,
    ].map((h) => h(jobManager, app)),
  );

  // Use monitor and Sentry to collect job statistics and report errors
  jobManager.use((handler) => async (job) => {
    const timerName = `job-${job.name}-time`;
    const requestsName = `job-${job.name}-requests`;
    const errorsName = `job-${job.name}-errors`;

    const timer = monitor.timer(timerName);

    try {
      const result = await handler(job);
      monitor.increment(requestsName);
      return result;
    } catch (err) {
      monitor.increment(errorsName);

      if ('sentryDsn' in config) {
        Raven.captureException(err, {
          extra: { err: `error processing job '${job.name}': ${err.message}` },
        });
      }

      // Job is still failed
      throw err;
    } finally {
      timer.stop();
    }
  });

  if (process.env.NODE_ENV !== 'test') {
    // Delay the start of the job polling for a random interval. In multi-node
    // environment it will allow a more even distribution of the job fetching.
    setTimeout(
      () => jobManager.startPolling(),
      Math.random() * config.jobManager.pollInterval * 1000,
    );
  }

  return jobManager;
}
