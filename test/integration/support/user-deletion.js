/* eslint-env node, mocha */
/* global $pg_database */
import path from 'path';
import { promises as fs } from 'fs';

import expect from 'unexpected';

import cleanDB from '../../dbCleaner';
import { User, dbAdapter, Post, Comment, Group, Attachment } from '../../../app/models';
import {
  deletePersonalInfo,
  deletePosts,
  deleteLikes,
  deleteCommentLikes,
  unbanAll,
  deleteSubscriptions,
  deleteSubscriptionRequests,
  deleteAuxHomeFeeds,
  deleteNotifications,
  deleteAppTokens,
  deleteExtAuthProfiles,
  deleteArchives,
  anonymizeInvitations,
  deleteAllUserData,
  deleteAttachments,
} from '../../../app/support/user-deletion';
import { GONE_DELETION } from '../../../app/models/user';
import { filesMustExist } from '../helpers/attachments';

describe('User data deletion', () => {
  beforeEach(() => cleanDB($pg_database));

  let luna, mars;

  beforeEach(async () => {
    luna = new User({
      username: `luna`,
      screenName: 'Luna Lovegood',
      description: 'Luna Love Good',
      email: 'luna.lovegood@example.com',
      password: 'password',
      preferences: { acceptDirectsFrom: User.ACCEPT_DIRECTS_FROM_ALL },
    });
    mars = new User({ username: `mars`, password: 'password' });
    await Promise.all([luna, mars].map((user) => user.create()));
  });

  it(`should pass smoke test`, () =>
    expect(deleteAllUserData(luna.id, afterHour()), 'to be fulfilled'));

  it(`should delete user personal data`, async () => {
    await luna.setGoneStatus(GONE_DELETION);

    await deletePersonalInfo(luna.id);
    const newData = await dbAdapter.database.getRow(`select * from users where uid = ?`, luna.id);

    expect(newData, 'to satisfy', {
      uid: luna.id,
      username: 'luna',
      screen_name: 'luna',
      description: '',
      hashed_password: '',
      gone_status: GONE_DELETION,
    });
  });

  it(`should keep the 'invitedBy' field when invited user deleted`, async () => {
    const invitationCode = await luna.createInvitation({
      message: 'Welcome to Freefeed!',
      lang: 'en',
      singleUse: true,
      users: ['luna', 'mars', 'jupiter'],
      groups: [],
    });
    const invitation = await dbAdapter.getInvitation(invitationCode);
    const venus = new User({
      username: `venus`,
      password: 'password',
      invitationId: invitation.id,
    });
    await venus.create();

    {
      const data = await dbAdapter.database.getRow(`select * from users where uid = ?`, venus.id);
      expect(data, 'to satisfy', {
        uid: venus.id,
        username: 'venus',
        invitation_id: invitation.id,
      });
    }

    await deletePersonalInfo(venus.id);

    {
      const data = await dbAdapter.database.getRow(`select * from users where uid = ?`, venus.id);
      expect(data, 'to satisfy', {
        uid: venus.id,
        username: 'venus',
        invitation_id: invitation.id,
      });
    }
  });

  it(`should delete user posts`, async () => {
    const timelineId = await luna.getPostsTimelineId();

    for (let i = 0; i < 3; i++) {
      const post = new Post({
        userId: luna.id,
        body: `Post #${i + 1}`,
        timelineIds: [timelineId],
      });
      // eslint-disable-next-line no-await-in-loop
      await post.create();
    }

    await deletePosts(luna.id, afterHour());
    const postIds = await dbAdapter.database.getCol(
      `select uid from posts where user_id = ?`,
      luna.id,
    );
    expect(postIds, 'to be empty');
  });

  it(`should delete user likes`, async () => {
    const marsPost = new Post({
      userId: mars.id,
      body: `Post`,
      timelineIds: [await mars.getPostsTimelineId()],
    });
    await marsPost.create();

    await marsPost.addLike(luna);

    {
      const likes = await dbAdapter.database.getAll(
        `select * from likes where user_id = ?`,
        luna.id,
      );
      expect(likes, 'to satisfy', [{ user_id: luna.id, post_id: marsPost.id }]);
    }

    await deleteLikes(luna.id, afterHour());

    {
      const likes = await dbAdapter.database.getAll(
        `select * from likes where user_id = ?`,
        luna.id,
      );
      expect(likes, 'to be empty');
    }
  });

  it(`should delete user comment likes`, async () => {
    const marsPost = new Post({
      userId: mars.id,
      body: `Post`,
      timelineIds: [await mars.getPostsTimelineId()],
    });
    await marsPost.create();

    const marsComment = new Comment({
      userId: mars.id,
      postId: marsPost.id,
      body: 'Comment',
    });
    await marsComment.create();

    await marsComment.addLike(luna);

    {
      const likes = await dbAdapter.database.getAll(
        `select * from comment_likes where user_id = ?`,
        luna.intId,
      );
      expect(likes, 'to have length', 1);
    }

    await deleteCommentLikes(luna.id, afterHour());

    {
      const likes = await dbAdapter.database.getAll(
        `select * from comment_likes where user_id = ?`,
        luna.intId,
      );
      expect(likes, 'to be empty');
    }
  });

  it(`should delete user bans`, async () => {
    await luna.ban(mars.username);

    await unbanAll(luna.id, afterHour());

    {
      const bans = await dbAdapter.database.getAll(`select * from bans where user_id = ?`, luna.id);
      expect(bans, 'to be empty');
    }
  });

  it(`should delete user subscriptions`, async () => {
    await luna.subscribeTo(mars);

    await deleteSubscriptions(luna.id, afterHour());

    {
      const friends = await luna.getSubscriptionsWithHomeFeeds();
      expect(friends, 'to be empty');
    }
  });

  it(`should delete user subscription requests`, async () => {
    const celestials = new Group({ username: 'celestials' });
    await celestials.create(mars.id);

    await Promise.all([mars, celestials].map((acc) => acc.update({ isPrivate: '1' })));

    await Promise.all([mars, celestials].map((acc) => luna.sendSubscriptionRequest(acc.id)));

    {
      const requests = await luna.getPendingSubscriptionRequestIds();
      expect(requests, 'to have length', 2);
    }

    await deleteSubscriptionRequests(luna.id, afterHour());

    {
      const requests = await luna.getPendingSubscriptionRequestIds();
      expect(requests, 'to be empty');
    }
  });

  it(`should delete auxiliary home feeds`, async () => {
    await luna.createHomeFeed('Feed 1');
    await luna.createHomeFeed('Feed 2');

    {
      const feeds = await luna.getHomeFeeds();
      expect(feeds, 'to have length', 3);
    }

    await deleteAuxHomeFeeds(luna.id);

    {
      const feeds = await luna.getHomeFeeds();
      expect(feeds, 'to satisfy', [{ isInherent: true }]);
    }
  });

  it(`should delete user's notifications caused by the user themself`, async () => {
    await luna.ban(mars.username);

    // Ban caused two notification: for Luna themself and for Mars
    {
      const notifications = await dbAdapter.database.getAll(`select * from events`);
      expect(notifications, 'to have length', 2);
    }

    await deleteNotifications(luna.id);

    {
      const notifications = await dbAdapter.database.getAll(`select * from events`);
      expect(notifications, 'to have length', 1);
    }
  });

  it(`should delete app tokens`, async () => {
    await dbAdapter.createAppToken({ userId: luna.id, title: 'Token 1' });
    await dbAdapter.createAppToken({ userId: luna.id, title: 'Token 2' });

    {
      const tokenIds = await dbAdapter.database.getAll(
        `select uid from app_tokens where user_id = ?`,
        luna.id,
      );
      expect(tokenIds, 'to have length', 2);
    }

    await deleteAppTokens(luna.id, afterHour());

    {
      const tokenIds = await dbAdapter.database.getAll(
        `select uid from app_tokens where user_id = ?`,
        luna.id,
      );
      expect(tokenIds, 'to be empty');
    }
  });

  it(`should delete ext auth profiles`, async () => {
    await luna.addOrUpdateExtProfile({
      provider: 'facebook',
      externalId: '111',
      title: 'Luna Lovegood',
    });
    await luna.addOrUpdateExtProfile({
      provider: 'facebook',
      externalId: '222',
      title: 'Luna Maximoff',
    });

    {
      const profiles = await dbAdapter.database.getCol(`select uid from external_auth`);
      expect(profiles, 'to have length', 2);
    }

    await deleteExtAuthProfiles(luna.id);

    {
      const profiles = await dbAdapter.database.getCol(`select uid from external_auth`);
      expect(profiles, 'to be empty');
    }
  });

  it(`should delete archives info`, async () => {
    await dbAdapter.setUserArchiveParams(luna.id, 'oldluna', {
      has_archive: true,
      via_sources: [],
    });

    expect(await dbAdapter.getUserArchiveParams(luna.id), 'not to be null');

    await deleteArchives(luna.id);

    expect(await dbAdapter.getUserArchiveParams(luna.id), 'to be null');
  });

  it(`should anonymize invitations`, async () => {
    await luna.createInvitation({
      message: 'Welcome to Freefeed!',
      lang: 'en',
      singleUse: true,
      users: ['luna', 'mars', 'jupiter'],
      groups: [],
    });
    await luna.createInvitation({
      message: 'Welcome to Freefeed again!',
      lang: 'ru',
      singleUse: false,
      users: ['luna', 'jupiter'],
      groups: ['selenites'],
    });

    expect(await dbAdapter.database.getOne(`select count(*)::int from invitations`), 'to be', 2);

    await anonymizeInvitations(luna.id);

    const rows = await dbAdapter.database.getAll(`select * from invitations order by created_at`);

    expect(rows, 'to satisfy', [
      {
        message: '',
        lang: 'en',
        single_use: true,
        recommendations: {},
      },
      {
        message: '',
        lang: 'en',
        single_use: false,
        recommendations: {},
      },
    ]);
  });

  it(`should delete attachments`, async () => {
    const localFile = path.resolve(__dirname, '../../fixtures/test-image.900x300.png');
    const uploadedFile = '/tmp/upload_23456789012345678901234567890123_1';
    // "Upload" file
    await fs.copyFile(localFile, uploadedFile);

    const att = await Attachment.create(uploadedFile, path.basename(localFile), luna);
    await filesMustExist(att);

    await deleteAttachments(luna.id, afterHour());

    expect(await dbAdapter.database.getOne(`select count(*)::int from attachments`), 'to be', 0);
    await filesMustExist(att, false);
  });
});

function afterHour() {
  return new Date(Date.now() + 60 * 60 * 1000);
}
