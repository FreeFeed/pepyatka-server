/* eslint-env node, mocha */
/* global $pg_database */
import { escape as urlEscape } from 'querystring';

import expect from 'unexpected';
import parseXML from 'xml-parser';
import { unescape as htmlUnescape, escape as htmlEscape } from 'lodash';
import config from 'config';

import cleanDB from '../dbCleaner';
import { textToHTML } from '../../app/support/rss-text-parser';

import {
  createUserAsync,
  performRequest,
  updateUserAsync,
  createAndReturnPost,
  createMockAttachmentAsync,
  updatePostAsync,
  createCommentAsync,
  createGroupAsync,
  createAndReturnPostToFeed,
  subscribeToAsync,
  createTestUsers,
  goProtected,
  goPrivate,
  mutualSubscriptions,
} from './functional_test_helper';

describe('TimelinesAsRSS', () => {
  beforeEach(() => cleanDB($pg_database));

  describe('User Luna', () => {
    let luna;
    beforeEach(async () => (luna = await createUserAsync('luna', 'pw')));

    it('should return a basic empty RSS for Luna', async () => {
      const resp = parseXML(await fetchUserTimelineAsRSS(luna));
      expect(resp.root, 'to satisfy', {
        name: 'rss',
        attributes: { version: '2.0' },
        children: [{ name: 'channel' }],
      });
      const channel = findNode(resp.root, 'channel');
      expect(channel.children, 'to satisfy', [
        { name: 'title', content: `Posts of ${luna.username} @ ${config.siteTitle}` },
        { name: 'link', content: `${config.host}/${luna.username}` },
        { name: 'description' },
        {
          name: 'image',
          children: [
            { name: 'url', content: config.profilePictures.defaultProfilePictureMediumUrl },
            { name: 'title', content: `Posts of ${luna.username} @ ${config.siteTitle}` },
            { name: 'link', content: `${config.host}/${luna.username}` },
          ],
        },
      ]);
    });

    it('should return RSS with user description', async () => {
      await updateUserAsync(luna, { description: 'I am Luna!' });
      const resp = parseXML(await fetchUserTimelineAsRSS(luna));
      const description = findNode(resp.root, 'channel', 'description');
      expect(description, 'to satisfy', { content: 'I am Luna!' });
    });

    it('should return RSS with a post', async () => {
      const post = await createAndReturnPost(
        luna,
        `Tiger, @tiger, burning bright
        In the forests of the night,
        What immortal.com hand or eye
        Dare frame thy fearful #symmetry?`,
      );
      await updateUserAsync(luna, { description: 'I am Luna!' });
      const resp = parseXML(await fetchUserTimelineAsRSS(luna));
      const channel = findNode(resp.root, 'channel');
      const items = channel.children.filter(({ name }) => name === 'item');

      expect(items, 'to have length', 1);
      expect(items[0].children, 'to satisfy', [
        { name: 'guid', content: `freefeed:post:${post.id}` },
        { name: 'pubDate', content: new Date(+post.createdAt).toGMTString() },
        { name: 'link', content: `${config.host}/${luna.username}/${post.id}` },
        { name: 'author', content: luna.username },
        { name: 'title', content: `Tiger, @tiger, burning bright` },
        { name: 'description' },
      ]);

      const description = htmlUnescape(findNode(items[0], 'description').content);
      expect(
        description,
        'to be',
        [
          `<p class="freefeed-author">`,
          `<a href="${config.host}/${luna.username}"><img src="${config.profilePictures.defaultProfilePictureMediumUrl}" width="50" height="50"></a>`,
          `<a href="${config.host}/${luna.username}"><strong>${luna.username}</strong></a>:`,
          `</p>`,
          `<div class="freefeed-post">`,
          textToHTML(post.body),
          `</div>`,
        ].join('\n'),
      );
    });

    it('should return RSS with a post with attachments', async () => {
      const att1 = await createMockAttachmentAsync(luna);
      const att2 = await createMockAttachmentAsync(luna);
      const post = await createAndReturnPost(luna, `Tiger, tiger, burning bright`);
      luna.post = post;
      await updatePostAsync(luna, {
        body: post.body,
        attachments: [att1.id, att2.id],
      });
      const resp = parseXML(await fetchUserTimelineAsRSS(luna));

      const item = findNode(resp.root, 'item');
      expect(item.children, 'to have an item satisfying', {
        name: 'enclosure',
        attributes: {
          url: `${config.host}/attachments/${att1.id}.jpg`,
          length: `${att1.fileSize}`,
          type: 'image/jpeg',
        },
      });
      expect(item.children, 'to have an item satisfying', {
        name: 'enclosure',
        attributes: {
          url: `${config.host}/attachments/${att2.id}.jpg`,
          length: `${att2.fileSize}`,
          type: 'image/jpeg',
        },
      });

      const description = htmlUnescape(findNode(item, 'description').content);
      expect(
        description,
        'to be',
        [
          `<p class="freefeed-author">`,
          `<a href="${config.host}/${luna.username}"><img src="${config.profilePictures.defaultProfilePictureMediumUrl}" width="50" height="50"></a>`,
          `<a href="${config.host}/${luna.username}"><strong>${luna.username}</strong></a>:`,
          `</p>`,
          `<div class="freefeed-post">`,
          textToHTML(post.body),
          `</div>`,
          `<p class="freefeed-images">` +
            // Strange src and href here because of incomplete attach implementation in createMockAttachmentAsync
            `<a href="${config.host}/attachments/${att1.id}.jpg">` +
            `<img src="${config.host}/attachments/thumbnails/${att1.id}.jpg" width="${att1.imageSizes.t.w}" height="${att1.imageSizes.t.h}"></a>` +
            ` ` +
            `<a href="${config.host}/attachments/${att2.id}.jpg">` +
            `<img src="${config.host}/attachments/thumbnails/${att2.id}.jpg" width="${att2.imageSizes.t.w}" height="${att2.imageSizes.t.h}"></a>` +
            `</p>`,
        ].join('\n'),
      );
    });

    it('should return RSS with a post with many comments of post author', async () => {
      const post = await createAndReturnPost(luna, `Tiger, tiger, burning bright`);
      const comments = [];

      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await createCommentAsync(luna, post.id, `Comment ${i + 1}`);
        comments.push(`Comment ${i + 1}`);
      }

      const resp = parseXML(await fetchUserTimelineAsRSS(luna));
      const description = htmlUnescape(findNode(resp.root, 'item', 'description').content);
      expect(
        description,
        'to be',
        [
          `<p class="freefeed-author">`,
          `<a href="${config.host}/${luna.username}"><img src="${config.profilePictures.defaultProfilePictureMediumUrl}" width="50" height="50"></a>`,
          `<a href="${config.host}/${luna.username}"><strong>${luna.username}</strong></a>:`,
          `</p>`,
          `<div class="freefeed-post">`,
          textToHTML(post.body),
          `</div>`,
          ...comments.map(
            (c) =>
              `<div class="freefeed-comment" style="margin-left: 1em; margin-top: 2em;"><p>${c}</p></div>`,
          ),
        ].join('\n'),
      );
    });

    it('should return RSS with a post with many comments of post author and the one Mars comment between them', async () => {
      const mars = await createUserAsync('mars', 'pw');
      const post = await createAndReturnPost(luna, `Tiger, tiger, burning bright`);
      const comments = [];

      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        await createCommentAsync(luna, post.id, `Comment ${i + 1}`);
        comments.push(`Comment ${i + 1}`);
      }

      await createCommentAsync(mars, post.id, `Comment from Mars!`);

      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        await createCommentAsync(luna, post.id, `Comment 3+${i + 1}`);
      }

      const resp = parseXML(await fetchUserTimelineAsRSS(luna));
      const description = htmlUnescape(findNode(resp.root, 'item', 'description').content);
      expect(
        description,
        'to be',
        [
          `<p class="freefeed-author">`,
          `<a href="${config.host}/${luna.username}"><img src="${config.profilePictures.defaultProfilePictureMediumUrl}" width="50" height="50"></a>`,
          `<a href="${config.host}/${luna.username}"><strong>${luna.username}</strong></a>:`,
          `</p>`,
          `<div class="freefeed-post">`,
          textToHTML(post.body),
          `</div>`,
          ...comments.map(
            (c) =>
              `<div class="freefeed-comment" style="margin-left: 1em; margin-top: 2em;"><p>${c}</p></div>`,
          ),
        ].join('\n'),
      );
    });
  });

  describe('Group RSS', () => {
    let luna, mars, celestials, post1, post2;
    beforeEach(async () => {
      [luna, mars] = await Promise.all([
        createUserAsync('luna', 'pw'),
        createUserAsync('mars', 'pw'),
      ]);
      celestials = await createGroupAsync(luna, 'celestials', 'Celestials');
      await subscribeToAsync(mars, celestials);
      post1 = await createAndReturnPostToFeed(celestials, luna, 'Luna post');
      post2 = await createAndReturnPostToFeed(celestials, mars, 'Mars post');
    });

    it('should return an RSS for group', async () => {
      const resp = parseXML(await fetchUserTimelineAsRSS(celestials));
      expect(resp.root, 'to satisfy', {
        name: 'rss',
        attributes: { version: '2.0' },
        children: [{ name: 'channel' }],
      });
      const channel = findNode(resp.root, 'channel');
      expect(channel.children, 'to satisfy', [
        { name: 'title', content: `Posts in group ${celestials.username} @ ${config.siteTitle}` },
        { name: 'link', content: `${config.host}/${celestials.username}` },
        { name: 'description' },
        {
          name: 'image',
          children: [
            { name: 'url', content: config.profilePictures.defaultProfilePictureMediumUrl },
            {
              name: 'title',
              content: `Posts in group ${celestials.username} @ ${config.siteTitle}`,
            },
            { name: 'link', content: `${config.host}/${celestials.username}` },
          ],
        },
        { name: 'item' },
        { name: 'item' },
      ]);

      const items = channel.children.filter(({ name }) => name === 'item');
      expect(items[0].children, 'to satisfy', [
        { name: 'guid', content: `freefeed:post:${post2.id}` },
        { name: 'pubDate', content: new Date(+post2.createdAt).toGMTString() },
        { name: 'link', content: `${config.host}/${celestials.username}/${post2.id}` },
        { name: 'author', content: mars.username },
        { name: 'title', content: `${mars.username}: Mars post` },
        { name: 'description' },
      ]);
      expect(items[1].children, 'to satisfy', [
        { name: 'guid', content: `freefeed:post:${post1.id}` },
        { name: 'pubDate', content: new Date(+post1.createdAt).toGMTString() },
        { name: 'link', content: `${config.host}/${celestials.username}/${post1.id}` },
        { name: 'author', content: luna.username },
        { name: 'title', content: `${luna.username}: Luna post` },
        { name: 'description' },
      ]);
    });
  });

  describe('Access control', () => {
    let luna, mars, pluto;
    beforeEach(async () => {
      [luna, mars, pluto] = await createTestUsers(3);
      await mutualSubscriptions([luna, pluto]);
      await createAndReturnPost(luna, `Tiger, tiger, burning bright`);
    });

    describe('Luna is protected user', () => {
      beforeEach(async () => await goProtected(luna));

      it('should not show Luna posts to anonymous', async () => {
        const resp = parseXML(await fetchUserTimelineAsRSS(luna));
        const channel = findNode(resp.root, 'channel');
        const items = channel.children.filter(({ name }) => name === 'item');
        expect(items, 'to have length', 0);
      });

      it('should show Luna posts to Mars', async () => {
        const resp = parseXML(await fetchUserTimelineAsRSS(luna, mars));
        const channel = findNode(resp.root, 'channel');
        const items = channel.children.filter(({ name }) => name === 'item');
        expect(items, 'to have length', 1);
      });
    });

    describe('Luna is private user', () => {
      beforeEach(async () => await goPrivate(luna));

      it('should not show Luna posts to anonymous', async () => {
        const resp = parseXML(await fetchUserTimelineAsRSS(luna));
        const channel = findNode(resp.root, 'channel');
        const items = channel.children.filter(({ name }) => name === 'item');
        expect(items, 'to have length', 0);
      });

      it('should not show Luna posts to Mars', async () => {
        const resp = parseXML(await fetchUserTimelineAsRSS(luna, mars));
        const channel = findNode(resp.root, 'channel');
        const items = channel.children.filter(({ name }) => name === 'item');
        expect(items, 'to have length', 0);
      });

      it('should show Luna posts to Pluto', async () => {
        const resp = parseXML(await fetchUserTimelineAsRSS(luna, pluto));
        const channel = findNode(resp.root, 'channel');
        const items = channel.children.filter(({ name }) => name === 'item');
        expect(items, 'to have length', 1);
      });
    });
  });

  describe('Autodiscovery metatags', () => {
    let luna, celestials;
    beforeEach(async () => {
      luna = await createUserAsync('luna', 'pw');
      celestials = await createGroupAsync(luna, 'celestials', 'Celestials');
    });

    it('should return metatag for user', async () => {
      const meta = await fetchMetatags(luna.username);

      const rssURL = `${config.host}/v2/timelines-rss/${urlEscape(luna.username)}`;
      const rssTitle = `Posts of ${luna.username}`;
      const tag = `<link rel="alternate" type="application/rss+xml" title="${htmlEscape(
        rssTitle,
      )}" href="${htmlEscape(rssURL)}" data-react-helmet="true">`;
      expect(meta, 'to contain', tag);
    });

    it('should return metatag for group', async () => {
      const meta = await fetchMetatags(celestials.username);

      const rssURL = `${config.host}/v2/timelines-rss/${urlEscape(celestials.username)}`;
      const rssTitle = `Posts in group ${celestials.username}`;
      const tag = `<link rel="alternate" type="application/rss+xml" title="${htmlEscape(
        rssTitle,
      )}" href="${htmlEscape(rssURL)}" data-react-helmet="true">`;
      expect(meta, 'to contain', tag);
    });

    it('should not return metatag for unexisting user', async () => {
      const meta = await fetchMetatags('evita');
      expect(meta, 'not to contain', `<link rel="alternate" type="application/rss+xml"`);
    });
  });
});

const fetchUserTimelineAsRSS = async (userContext, viewerContext = null) => {
  const headers = {};

  if (viewerContext) {
    headers['X-Authentication-Token'] = viewerContext.authToken;
  }

  const response = await performRequest(`/v2/timelines-rss/${userContext.username}`, { headers });

  if (response.status !== 200) {
    const { err } = await response.json();
    expect.fail('HTTP error (code {0}): {1}', response.status, err);
  }

  expect(response.headers.get('Content-Type'), 'to be', 'application/xml');
  return await response.text();
};

async function fetchMetatags(username) {
  const response = await performRequest(`/v2/timelines-metatags/${username}`);

  if (response.status !== 200) {
    const { err } = await response.json();
    expect.fail('HTTP error (code {0}): {1}', response.status, err);
  }

  return await response.text();
}

function findNode(node, ...nodeNames) {
  if (nodeNames.length === 0) {
    return node;
  }

  const [nodeName, ...otherNames] = nodeNames;

  if (node.name === nodeName) {
    return findNode(node, ...otherNames);
  }

  for (const child of node.children) {
    const found = findNode(child, ...nodeNames);

    if (found) {
      return findNode(found, ...otherNames);
    }
  }

  return null;
}
