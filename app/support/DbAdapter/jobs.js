import { Job } from '../../models';

import { prepareModelPayload, initObject } from './utils';

export default function jobsTrait(superClass) {
  return class extends superClass {
    async createJob(name, payload = {}, { unlockAt, uniqKey } = {}) {
      const row = await this.database.getRow(
        `insert into jobs 
          (name, payload, unlock_at, uniq_key) 
          values (:name, :payload, :unlockAt, :uniqKey)
          on conflict (name, uniq_key) do 
            update set (payload, unlock_at) = (:payload, :unlockAt)
          returning *`,
        { name, payload, uniqKey, unlockAt: this._jobUnlockAt(unlockAt) },
      );

      return initJobObject(row);
    }

    async updateJob(id, { unlockAt = 0, failure = null } = {}) {
      const toUpdate = { unlock_at: this._jobUnlockAt(unlockAt) };

      if (failure === true) {
        toUpdate.failures = this.database.raw('failures + 1');
      } else if (failure === false) {
        toUpdate.failures = 0;
      }

      const [row] = await this.database('jobs').update(toUpdate).where({ id }).returning('*');
      return initJobObject(row);
    }

    async getJobById(id) {
      const row = await this.database.getRow(`select * from jobs where id = :id`, { id });
      return initJobObject(row);
    }

    async deleteJob(id) {
      await this.database.raw(`delete from jobs where id = :id`, { id });
    }

    /**
     * @param {number} count - number of jobs to fetch
     * @param {number} lockTime - in seconds
     * @param {Record<string, int>} limitedJobs - names of jobs with limited
     * number of simultaneous executions
     * @returns {Promise<Job[]>}
     */
    async fetchJobs(count, lockTime, limitedJobs = {}) {
      const limData = Object.entries(limitedJobs).map(([name, lim]) => ({ name, lim }));
      let rows;

      if (limData.length === 0) {
        // Simple case, no limited jobs
        rows = await this.database.getAll(
          `update jobs set
              unlock_at = now() + :lockTime * '1 second'::interval,
              attempts = attempts + 1
            where id = any(
              select id from jobs 
              where unlock_at <= now()
              order by unlock_at
              for update skip locked
              limit :count
            )
            returning *`,
          { count, lockTime },
        );
      } else {
        // Case with limited jobs
        rows = await this.database.getAll(
          `with
          -- Parse job limits from input JSON
          limits as (
              select name, lim
              from jsonb_to_recordset(:limData) as x(name text, lim int)
          ),
          -- Count currently locked jobs for each job type
          locked_counts as (
              select name, count(*) as locked_count
              from jobs
              where unlock_at > now()
              group by name
          ),
          -- Get available jobs and lock them immediately
          lockable_jobs as (
              select id, name, unlock_at
              from jobs
              where unlock_at <= now()
              for update skip locked
          ),
          -- Number locked jobs within each job type
          numbered_jobs as (
              select 
                  id, 
                  name,
                  unlock_at,
                  row_number() over (partition by name) as row_num
              from lockable_jobs
          ),
          -- Select jobs respecting limits and max count
          selected_jobs as (
              select j.id
              from numbered_jobs j
              left join limits l on j.name = l.name
              left join locked_counts lc on j.name = lc.name
              where 
                  l.name is null -- no limits for this job type
                  or j.row_num + coalesce(lc.locked_count, 0) <= l.lim -- within limits
              order by j.unlock_at
              limit :count
          )
          -- Update selected jobs with new unlock time
          update jobs
          set unlock_at = now() + :lockTime * '1 second'::interval,
              attempts = attempts + 1
          where id in (select id from selected_jobs)
          returning *`,
          { count, lockTime, limData: JSON.stringify(limData) },
        );
      }

      return rows.map(initJobObject);
    }

    // For testing purposes only
    async getAllJobs(names = null) {
      let rows;

      if (names) {
        rows = await this.database.getAll(
          `select * from jobs where name = any(:names) order by created_at`,
          { names },
        );
      } else {
        rows = await this.database.getAll(`select * from jobs order by created_at`);
      }

      return rows.map(initJobObject);
    }

    _jobUnlockAt(unlockAt) {
      if (Number.isFinite(unlockAt)) {
        return this.database.raw(`now() + :unlockAt * '1 second'::interval`, { unlockAt });
      } else if (unlockAt instanceof Date) {
        return unlockAt.toISOString();
      }

      return this.database.raw('default');
    }
  };
}

function initJobObject(row) {
  if (!row) {
    return null;
  }

  row = prepareModelPayload(row, JOB_FIELDS, JOB_FIELDS_MAPPING);
  return initObject(Job, row, row.id);
}

const JOB_FIELDS = {
  id: 'id',
  created_at: 'createdAt',
  unlock_at: 'unlockAt',
  name: 'name',
  payload: 'payload',
  attempts: 'attempts',
  failures: 'failures',
  uniq_key: 'uniqKey',
};

const JOB_FIELDS_MAPPING = {};
