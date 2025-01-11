import { resolve } from 'path';

import stubTransport from 'nodemailer-stub-transport';

module.exports = {
  port: 31337,
  database: 3,
  monitorPrefix: 'tests',

  application: { EXTRA_STOP_LIST: ['thatcreepyguy', 'nicegirlnextdoor', 'perfectstranger'] },
  media: { storage: { rootDir: '/tmp/pepyatka-media/' } },
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
