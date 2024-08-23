/**
 * Wrapper around knex that adds some helper methods (see dbHelpers below).
 *
 * @param {import('knex').Knex} db
 * @returns {import('knex').Knex & typeof dbHelpers}
 */
export function withDbHelpers(db) {
  // db is a function with additional properties, so extending is tricky
  const wrapper = Object.assign(function (...args) {
    return db.apply(this, args); // eslint-disable-line prefer-reflect
  }, dbHelpers);
  Object.setPrototypeOf(wrapper, db); // eslint-disable-line prefer-reflect
  return wrapper;
}

const dbHelpers = {
  /**
   * @param {string} sql
   * @param {Record<string, unknown>} args
   * @returns {Promise<unknown[]>}
   */
  async getAll(sql, args = {}) {
    const { rows } = await this.raw(sql, args);
    return rows;
  },

  /**
   * @param {string} sql
   * @param {Record<string, unknown>} args
   * @returns {Promise<unknown>}
   */
  async getRow(sql, args = {}) {
    const rows = await this.getAll(sql, args);
    return rows[0];
  },

  /**
   * @param {string} sql
   * @param {Record<string, unknown>} args
   * @param {number} column
   * @returns {Promise<unknown>}
   */
  async getOne(sql, args = {}, column = 0) {
    const cols = await this.getCol(sql, args, column);
    return cols[0];
  },

  /**
   * @param {string} sql
   * @param {Record<string, unknown>} args
   * @param {number|string} column
   * @returns {Promise<unknown[]>}
   */
  async getCol(sql, args = {}, column = 0) {
    const { rows, fields } = await this.raw(sql, args);

    if (typeof column === 'number') {
      column = fields[column].name;
    }

    return rows.map((r) => r[column]);
  },

  /**
   * @param {Function} action
   * @returns {Promise<unknown>}
   */
  transaction(action) {
    // eslint-disable-next-line prefer-reflect
    return Object.getPrototypeOf(this).transaction((trx) => action(withDbHelpers(trx)));
  },
};
