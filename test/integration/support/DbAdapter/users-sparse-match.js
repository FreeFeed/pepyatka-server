/* eslint-env node, mocha */
/* global $pg_database */
import expect from 'unexpected';

import cleanDB from '../../../dbCleaner';
import { User, dbAdapter } from '../../../../app/models';

describe('sparseMatchesUserIds', () => {
  before(() => cleanDB($pg_database));

  const usernames = ['luna', 'uranus', 'antenna', 'mars', 'venus', 'jupiter', 'saturn'];
  let users;

  before(async () => {
    users = usernames.map((username) => new User({ username, password: 'pw' }));
    await Promise.all(users.map((user) => user.create()));
  });

  it('should find users that matches "a"', async () => {
    const ids = await dbAdapter.sparseMatchesUserIds('a');
    const names = ids.map((id) => users.find((u) => u.id === id).username);
    expect(
      names,
      'when sorted',
      'to equal',
      ['luna', 'uranus', 'antenna', 'mars', 'saturn'].sort(),
    );
  });

  it('should find users that matches "ua"', async () => {
    const ids = await dbAdapter.sparseMatchesUserIds('ua');
    const names = ids.map((id) => users.find((u) => u.id === id).username);
    expect(names, 'when sorted', 'to equal', ['luna', 'uranus'].sort());
  });

  it('should find users that matches "an"', async () => {
    const ids = await dbAdapter.sparseMatchesUserIds('an');
    const names = ids.map((id) => users.find((u) => u.id === id).username);
    expect(names, 'when sorted', 'to equal', ['antenna', 'uranus', 'saturn'].sort());
  });

  describe('Luna goes private', () => {
    before(() => users.find((u) => u.username === 'luna').update({ isPrivate: '1' }));
    after(() =>
      users.find((u) => u.username === 'luna').update({ isPrivate: '0', isProtected: '0' }),
    );

    it('should find users that matches "ua", but without Luna', async () => {
      const ids = await dbAdapter.sparseMatchesUserIds('ua');
      const names = ids.map((id) => users.find((u) => u.id === id).username);
      expect(names, 'when sorted', 'to equal', ['uranus'].sort());
    });

    it('should find Luna using the exact query', async () => {
      const ids = await dbAdapter.sparseMatchesUserIds('luna');
      const names = ids.map((id) => users.find((u) => u.id === id).username);
      expect(names, 'when sorted', 'to equal', ['luna'].sort());
    });
  });
});
