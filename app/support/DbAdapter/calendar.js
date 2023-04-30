const calendarTrait = (superClass) =>
  class extends superClass {
    async checkTimezoneExists(tz) {
      const sql = 'select exists (select 1 from pg_timezone_names where name = :tz)';
      const exists = await this.database.getOne(sql, { tz });

      return exists;
    }

    async getMyCalendarRangeDaysWithPosts(currentUserId, fromDate, toDate, tz) {
      const postsRestrictionsSQL = await this.postsVisibilitySQL(currentUserId);

      const sql = `
        SELECT
          TO_CHAR(p.created_at at time zone :tz, 'YYYY-MM-DD') as "date",
          count(*)::int as "posts"
        FROM
          posts p
        JOIN
          users u on p.user_id = u.uid

        WHERE
          p.user_id = :currentUserId AND
          p.created_at at time zone :tz >= :fromDate AND
          p.created_at at time zone :tz < :toDate AND
          ${postsRestrictionsSQL}
        GROUP BY date
        ORDER BY date
      `;

      const rows = await this.database.getAll(sql, { tz, currentUserId, fromDate, toDate });

      return rows;
    }

    async getMyCalendarDatePosts(currentUserId, date, tz, offset = 0, limit = 30) {
      const postsRestrictionsSQL = await this.postsVisibilitySQL(currentUserId);

      const sql = `
        SELECT
          p.uid
        FROM
          posts p
          join users u on p.user_id = u.uid
        WHERE
          p.user_id = :currentUserId AND
          DATE_TRUNC('day', p.created_at at time zone :tz) = :date AND
          ${postsRestrictionsSQL}
        ORDER BY
          p.created_at DESC
        LIMIT
          :limit
        OFFSET
          :offset
      `;

      const rows = await this.database.getAll(sql, { tz, currentUserId, date, limit, offset });

      return rows.map((r) => r.uid);
    }

    async getMyCalendarFirstDayWithPostsBeforeDate(currentUserId, beforeDate, tz) {
      const postsRestrictionsSQL = await this.postsVisibilitySQL(currentUserId);

      const sql = `
        SELECT
          TO_CHAR(p.created_at at time zone :tz, 'YYYY-MM-DD') as "date"
        FROM
          posts p
        JOIN
          users u on p.user_id = u.uid

        WHERE
          p.user_id = :currentUserId AND
          p.created_at at time zone :tz < :beforeDate AND
          ${postsRestrictionsSQL}
        ORDER BY p.created_at DESC
        LIMIT 1
      `;

      const previousDay = await this.database.getOne(sql, { tz, currentUserId, beforeDate });

      return previousDay;
    }

    async getMyCalendarFirstDayWithPostsAfterDate(currentUserId, fromDate, tz) {
      const postsRestrictionsSQL = await this.postsVisibilitySQL(currentUserId);

      const sql = `
        SELECT
          TO_CHAR(p.created_at at time zone :tz, 'YYYY-MM-DD') as "date"
        FROM
          posts p
        JOIN
          users u on p.user_id = u.uid

        WHERE
          p.user_id = :currentUserId AND
          p.created_at at time zone :tz > :fromDate AND
          ${postsRestrictionsSQL}
        ORDER BY p.created_at ASC
        LIMIT 1
      `;

      const nextDay = await this.database.getOne(sql, { tz, currentUserId, fromDate });

      return nextDay;
    }
  };

export default calendarTrait;
