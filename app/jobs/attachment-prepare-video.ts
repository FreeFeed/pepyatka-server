import { setInterval } from 'timers/promises';

import createDebug from 'debug';

import { dbAdapter, Job, JobManager } from '../models';
import { UUID } from '../support/types';

type Payload = { filePath: string; attId: UUID };

const debug = createDebug('freefeed:model:attachment');

export const ATTACHMENT_PREPARE_VIDEO = 'ATTACHMENT_PREPARE_VIDEO';

export async function createPrepareVideoJob(payload: Payload): Promise<void> {
  await Job.create(ATTACHMENT_PREPARE_VIDEO, payload, { uniqKey: payload.attId });
}

const refreshInterval = 60; // sec

export function initHandlers(jobManager: JobManager) {
  // Allow only one job at a time
  jobManager.limitedJobs[ATTACHMENT_PREPARE_VIDEO] = 1;

  jobManager.on(ATTACHMENT_PREPARE_VIDEO, async (job: Job<Payload>) => {
    const { filePath, attId } = job.payload;
    const att = await dbAdapter.getAttachmentById(attId);

    if (!att) {
      debug(`${ATTACHMENT_PREPARE_VIDEO}: the attachment ${attId} does not exist`);
      return;
    }

    if (!att.meta.inProgress) {
      debug(`${ATTACHMENT_PREPARE_VIDEO}: the attachment ${attId} is already processed`);
      return;
    }

    const abortController = new AbortController();

    try {
      await Promise.race([
        att.finalizeCreation(filePath),
        // The _finalizeCreation_ can take a long time, so keep the job locked
        // and re-lock it every _refreshInterval_
        keepJobLocked(job, refreshInterval, abortController.signal),
      ]);
    } finally {
      abortController.abort(); // Stop the refresh timer
    }
  });
}

async function keepJobLocked(job: Job, interval: number, abortSignal: AbortSignal): Promise<void> {
  await job.setUnlockAt(refreshInterval * 1.5);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of setInterval(interval, null, { signal: abortSignal })) {
    await job.setUnlockAt(interval * 1.5);
  }
}
