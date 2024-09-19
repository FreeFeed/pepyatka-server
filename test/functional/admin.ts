import { before, describe, it } from 'mocha';
import unexpected from 'unexpected';
import unexpectedDate from 'unexpected-date';
import { DateTime } from 'luxon';

import { dbAdapter } from '../../app/models';
import cleanDB from '../dbCleaner';
import {
  ACT_DISABLE_INVITES_FOR_USER,
  ACT_ENABLE_INVITES_FOR_USER,
  ACT_FREEZE_USER,
  ACT_GIVE_MODERATOR_RIGHTS,
  ACT_REMOVE_MODERATOR_RIGHTS,
  ACT_SUSPEND_USER,
  ACT_UNFREEZE_USER,
  ACT_UNSUSPEND_USER,
  ROLE_ADMIN,
  ROLE_MODERATOR,
} from '../../app/models/admins';

import {
  type UserCtx,
  performJSONRequest,
  authHeaders,
  cmpBy,
  createUserAsync,
  createTestUser,
} from './functional_test_helper';

const expect = unexpected.clone();
expect.use(unexpectedDate);

describe('Admin API', () => {
  before(() => cleanDB(dbAdapter.database));

  let luna: UserCtx;
  let mars: UserCtx;
  let venus: UserCtx;

  before(async () => {
    luna = await createTestUser('luna');
    mars = await createTestUser('mars');
    // Venus is created by Luna's invite
    const invitationCode = await luna.user.createInvitation({
      message: 'hi',
      lang: 'en',
      singleUse: true,
      groups: [],
      users: [],
    });
    const invitation = await dbAdapter.getInvitation(invitationCode);
    venus = await createUserAsync('venus', 'pw', { invitationId: invitation?.id });
    await Promise.all([
      dbAdapter.setUserAdminRole(luna.user.id, ROLE_ADMIN, true, {
        YES_I_WANT_TO_SET_ADMIN_FOR_TEST_ONLY: true,
      }),
      dbAdapter.setUserAdminRole(mars.user.id, ROLE_MODERATOR, true),
    ]);
  });

  describe('Who am I?', () => {
    it(`should require authorization for admin's whoami`, async () => {
      const response = await performJSONRequest('GET', `/api/admin/whoami`);
      await expect(response, 'to satisfy', { __httpCode: 401 });
    });

    it(`should not let non-admins to see admin's whoami`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/whoami`,
        null,
        authHeaders(venus),
      );
      await expect(response, 'to satisfy', { __httpCode: 403 });
    });

    it(`should let moderators to see admin's whoami`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/whoami`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        user: { id: mars.user.id, roles: [ROLE_MODERATOR] },
      });
    });

    it(`should let true admins to see admin's whoami`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/whoami`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        user: { id: luna.user.id, roles: [ROLE_ADMIN] },
      });
    });
  });

  describe('Journal', () => {
    it(`should not let anonymous users to see journal`, async () => {
      const response = await performJSONRequest('GET', `/api/admin/journal`);
      await expect(response, 'to satisfy', { __httpCode: 401 });
    });

    it(`should not let regular users to see journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal`,
        null,
        authHeaders(venus),
      );
      await expect(response, 'to satisfy', { __httpCode: 403 });
    });

    it(`should let moderators to see journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200, actions: [], isLastPage: true });
    });
  });

  describe('Add/remove/list moderators', () => {
    it(`should not let anonymous users to see members list`, async () => {
      const response = await performJSONRequest('GET', `/api/admin/members`);
      await expect(response, 'to satisfy', { __httpCode: 401 });
    });

    it(`should not let regular users to see members list`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/members`,
        null,
        authHeaders(venus),
      );
      await expect(response, 'to satisfy', { __httpCode: 403 });
    });

    it(`should not let moderators to see members list`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/members`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 403 });
    });

    it(`should let admins to see members list of Mars and Luna`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/members`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        users: expect.it(
          'when sorted by',
          cmpBy('id'),
          'to satisfy',
          [
            { id: luna.user.id, roles: [ROLE_ADMIN] },
            { id: mars.user.id, roles: [ROLE_MODERATOR] },
          ].sort(cmpBy('id')),
        ),
      });
    });

    it('should demote Mars from moderators', async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/members/${mars.username}/demote`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', { __httpCode: 200, user: { roles: [] } });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_REMOVE_MODERATOR_RIGHTS,
            admin_username: luna.username,
            target_username: mars.username,
            details: {},
          },
        ],
        isLastPage: true,
      });
    });

    it(`should return members list without Mars`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/members`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        users: [{ id: luna.user.id, roles: [ROLE_ADMIN] }],
      });
    });

    it('should make Mars moderator again', async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/members/${mars.username}/promote`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', { __httpCode: 200, user: { roles: [ROLE_MODERATOR] } });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal`,
        null,
        authHeaders(luna),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_GIVE_MODERATOR_RIGHTS,
            admin_username: luna.username,
            target_username: mars.username,
            details: {},
          },
          {
            action_name: ACT_REMOVE_MODERATOR_RIGHTS,
            admin_username: luna.username,
            target_username: mars.username,
            details: {},
          },
        ],
        isLastPage: true,
      });
    });
  });

  describe('Users freeze', () => {
    it(`should return empty list of frozen users`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/users/frozen`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        frozen: [],
        users: [],
        isLastPage: true,
      });
    });

    it(`should not freeze user with invalid 'freezeUntil'`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/freeze`,
        { freezeUntil: 'qwerty' },
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 422 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: { frozenUntil: null },
      });
    });

    it(`should not freeze user with 'freezeUntil' in the past`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/freeze`,
        { freezeUntil: DateTime.now().minus({ days: 1 }).toISO() },
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 422 });
    });

    it(`should freeze Venus with 'freezeUntil' in the future`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/freeze`,
        { freezeUntil: 'P1D' },
        authHeaders(mars),
      );
      const now = await dbAdapter.now();

      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: {
          frozenUntil: expect.it(
            'with date semantics',
            'to be close to',
            DateTime.fromJSDate(now).plus({ days: 1 }).toJSDate(),
          ),
        },
      });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );
      const now = await dbAdapter.now();

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_FREEZE_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {
              freezeUntil: expect.it(
                'with date semantics',
                'to be close to',
                DateTime.fromJSDate(now).plus({ days: 1 }).toJSDate(),
              ),
            },
          },
        ],
        isLastPage: false,
      });
    });

    it(`should return Venus in list of frozen users`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/users/frozen`,
        null,
        authHeaders(mars),
      );
      const now = await dbAdapter.now();

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        frozen: [
          {
            userId: venus.user.id,
            createdAt: expect.it('with date semantics', 'to be close to', now),
            expiresAt: expect.it(
              'with date semantics',
              'to be close to',
              DateTime.fromJSDate(now).plus({ days: 1 }).toJSDate(),
            ),
          },
        ],
        users: [{ id: venus.user.id }],
        isLastPage: true,
      });
    });

    it(`should unfreeze Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/unfreeze`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_UNFREEZE_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should not return Venus in list of frozen users`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/users/frozen`,
        null,
        authHeaders(mars),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        frozen: [],
        users: [],
        isLastPage: true,
      });
    });
  });

  describe('Users list and user info', () => {
    it(`should return list of all users ordered by createdAt`, async () => {
      const sortedUsers = [venus, mars, luna];
      const response = await performJSONRequest('GET', `/api/admin/users`, null, authHeaders(mars));
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        users: sortedUsers.map((c) => ({
          id: c.user.id,
          username: c.username,
          createdAt: c.user.createdAt,
          invitedBy: c.username === 'venus' ? 'luna' : null,
        })),
        isLastPage: true,
      });
    });

    it(`should return info about user`, async () => {
      const response = await getUserInfo(luna, mars);
      await expect(response, 'to satisfy', {
        __httpCode: 200,
        user: { id: luna.user.id },
      });
    });
  });

  describe('User suspend/unsuspend', () => {
    it(`should suspend Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/suspend`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: { goneStatus: 'SUSPENDED' },
      });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_SUSPEND_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should unsuspend Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/unsuspend`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await getUserInfo(venus, mars), 'to satisfy', {
        __httpCode: 200,
        user: { goneStatus: 'ACTIVE' },
      });
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_UNSUSPEND_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should not allow to unsuspend active Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/unsuspend`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 422, err: /not in SUSPENDED status/ });
    });
  });

  describe('Disable/enable invites for user', () => {
    it(`should disable invites for Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/disable-invites`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await venus.user.isInvitesDisabled(), 'to be true');
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_DISABLE_INVITES_FOR_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should enable invites for Venus`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/enable-invites`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 200 });
      await expect(await venus.user.isInvitesDisabled(), 'to be false');
    });

    it(`should have record about it in journal`, async () => {
      const response = await performJSONRequest(
        'GET',
        `/api/admin/journal?limit=1`,
        null,
        authHeaders(luna),
      );

      await expect(response, 'to satisfy', {
        __httpCode: 200,
        actions: [
          {
            action_name: ACT_ENABLE_INVITES_FOR_USER,
            admin_username: mars.username,
            target_username: venus.username,
            details: {},
          },
        ],
        isLastPage: false,
      });
    });

    it(`should not enable invites for Venus twice`, async () => {
      const response = await performJSONRequest(
        'POST',
        `/api/admin/users/${venus.username}/enable-invites`,
        null,
        authHeaders(mars),
      );
      await expect(response, 'to satisfy', { __httpCode: 422 });
    });
  });
});

function getUserInfo(userCtx: UserCtx, reqUserCtx: UserCtx | null = null) {
  return performJSONRequest(
    'GET',
    `/api/admin/users/${userCtx.username}/info`,
    null,
    authHeaders(reqUserCtx),
  );
}
