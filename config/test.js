import { resolve } from 'path';

import stubTransport from 'nodemailer-stub-transport';

import { getWorkerId } from '../app/support/parallel-testing';

module.exports = {
  port: 31337 + getWorkerId(),
  database: 3 + getWorkerId(),
  monitorPrefix: 'tests',

  application: { EXTRA_STOP_LIST: ['thatcreepyguy', 'nicegirlnextdoor', 'perfectstranger'] },
  media: { storage: { rootDir: '/tmp/pepyatka-media/' } },
  attachments: {
    imageSizes: {
      t: {
        path: 'attachments/thumbnails/', // must have trailing slash
        bounds: { width: 525, height: 175 },
      },
      t2: {
        path: 'attachments/thumbnails2/', // must have trailing slash
        bounds: { width: 1050, height: 350 },
      },
      anotherTestSize: {
        path: 'attachments/anotherTestSize/', // must have trailing slash
        bounds: { width: 1600, height: 1200 },
      },
    },
  },
  mailer: { transport: stubTransport },
  postgres: { connection: { database: 'freefeed_test' } },
  externalAuthProviders: [
    {
      template: 'facebook',
      params: {
        clientId: 'test',
        clientSecret: 'test',
      },
    },
    {
      id: 'test',
      title: 'Test',
      adapter: 'test',
      params: {
        clientId: 'test',
        clientSecret: 'test',
      },
    },
  ],

  registrationsLimit: { maxCount: 10 },

  userPreferences: {
    defaults: {
      // User does't want to view banned comments by default (for compatibility
      // with old tests)
      hideCommentsOfTypes: [
        2, // Comment.HIDDEN_AUTHOR_BANNED
        4, // Comment.HIDDEN_VIEWER_BANNED
      ],
    },
  },

  emailVerification: {
    domainBlockList: resolve(__dirname, '../test/emailDomainBlockList.txt'),
  },

  translation: {
    enabled: true,
    limits: {
      totalCharactersPerMonth: 500_000,
      userCharactersPerDay: 5_000,
    },
    service: 'test',
    serviceTitle: 'Test',
  },
};
