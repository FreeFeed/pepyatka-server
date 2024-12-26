import fs from 'fs';

import smtpTransport from 'nodemailer-smtp-transport';
import { deferConfig as defer } from 'config/defer';

const stubTransport = function () {
  return {
    name: 'minimal',
    version: '0.1.0',
    send: function (mail, callback) {
      const input = mail.message.createReadStream();
      input.pipe(process.stdout);
      input.on('end', () => {
        callback(null, true);
      });
    },
  };
};

const config = {
  siteTitle: 'FreeFeed',

  port: 3000,
  database: 2,

  // You MUST override the site secret in your config
  secret: undefined,

  origin: 'http://localhost:3333',
  appRoot: '.',
  acceptHashedPasswordsOnly: false,

  // Configure koa app to trust proxy headers:
  // X-Forwarded-Host, X-Forwarded-Proto and X-Forwarded-For
  trustProxyHeaders: false,
  proxyIpHeader: 'X-Forwarded-For',

  logResponseTime: true,
  // disableRealtime: true,
  onboardingUsername: 'welcome',
  recaptcha: { enabled: false },
  // sentryDsn: '',

  frontendPreferencesLimit: 65536,

  monitorPrefix: 'development',

  adminEmail: '',
};

// Site instance owner's requisites for use in the digest email footers
config.company = {
  title: 'Our Company',
  address: 'Our Company Address, City, Country',
};

config.host = defer((cfg) => `http://localhost:${cfg.port}`);

config.application = {
  // Unavailable for registration (reserved for internal use)
  USERNAME_STOP_LIST: [
    '404',
    'about',
    'account',
    'anonymous',
    'attachments',
    'dev',
    'files',
    'filter',
    'friends',
    'groups',
    'help',
    'home',
    'iphone',
    'list',
    'logout',
    'profilepics',
    'public',
    'requests',
    'search',
    'settings',
    'share',
    'signin',
    'signup',
    'summary',
  ],

  // Path to the file contains usernames unavailable for registration
  // (plain text file, one username per line).
  extraStopListPath: null,

  EXTRA_STOP_LIST: defer((cfg) => {
    const { extraStopListPath } = cfg.application;

    if (!extraStopListPath) {
      return [];
    }

    return fs.readFileSync(extraStopListPath).toString().split('\n').filter(Boolean);
  }),
};

config.media = {
  // Public URL prefix
  url: defer((cfg) => `${cfg.host}/`), // must have trailing slash

  // File storage
  storage: {
    // 'fs' for local file system or 's3' for AWS S3
    type: 'fs',

    // Parameters for 'fs'
    rootDir: './public/files/', // must have trailing slash

    // Parameters for 's3'
    accessKeyId: 'ACCESS-KEY-ID',
    secretAccessKey: 'SECRET-ACCESS-KEY',
    bucket: 'bucket-name',
    region: 'eu-west-1',
    // endpoint:        'nyc3.digitaloceanspaces.com',
    s3ConfigOptions: {},
  },
  // Files of these types are uplodes to S3 with 'Content-Disposition: inline'.
  // All other types will have 'Content-Disposition: attachment' to prevent
  // in-browser execution.
  inlineMimeTypes: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'video/mp4',
    'application/pdf',
    'text/plain',
  ],
  supportedExtensions: [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'mp3',
    'm4a',
    'ogg',
    'wav',
    'txt',
    'pdf',
    'doc',
    'docx',
    'ppt',
    'pptx',
    'xls',
    'xlsx',
  ],
};
config.attachments = {
  url: defer((cfg) => cfg.media.url),
  storage: defer((cfg) => cfg.media.storage),
  path: 'attachments/', // must have trailing slash
  fileSizeLimit: 10 * 1000 * 1000,
  maxCount: 20,
  imageSizes: {
    t: {
      path: 'attachments/thumbnails/', // must have trailing slash
      bounds: { width: 525, height: 175 },
    },
    t2: {
      path: 'attachments/thumbnails2/', // must have trailing slash
      bounds: { width: 1050, height: 350 },
    },
  },
  sanitizeMetadata: {
    // Media tags to remove via exiftool (using in Attachment.sanitizeMetadata)
    removeTags: [/GPS/i, /Serial/i, /Owner/i],
    // Non-writable tags: synthetic and permanent
    ignoreTags: [/^GPSPosition$/, /^SerialNumberFormat$/],
  },
  // Use https://imgproxy.net/ to dynamically create image thumbnails
  useImgProxy: false,
  previews: {
    imagePreviewAreas: {
      p1: 120_000,
      p2: 400_000,
      p3: 1_200_000,
      p4: 4_000_000,
    },
    legacyImagePreviewSizes: {
      thumbnails: { width: 525, height: 175 },
      thumbnails2: { width: 1050, height: 350 },
    },
  },
};
config.profilePictures = {
  defaultProfilePictureMediumUrl: 'http://placekitten.com/50/50',

  url: defer((cfg) => cfg.media.url),
  storage: defer((cfg) => cfg.media.storage),
  path: 'profilepics/', // must have trailing slash
};

config.mailer = {
  useSMTPTransport: false,
  transport: defer((cfg) => (cfg.mailer.useSMTPTransport ? smtpTransport : stubTransport)),
  fromName: 'Pepyatka',
  fromEmail: 'mail@pepyatka.com',
  host: defer((cfg) => cfg.host),
  options: {},
  adminRecipient: { email: 'admin@pepyatka.com', screenName: 'Pepyatka admin' },
  // Subjects
  resetPasswordMailSubject: 'Pepyatka password reset',
  dailyBestOfDigestMailSubject: defer(
    (cfg) => `The best of your ${cfg.siteTitle} for <%= digestDate %>`,
  ),
  weeklyBestOfDigestMailSubject: defer(
    (cfg) => `The best of your ${cfg.siteTitle} for the week of <%= digestDate %>`,
  ),
  notificationDigestEmailSubject: 'Notifications digest for <%= digestInterval %>',
};

config.redis = {
  host: 'localhost',
  port: 6379,
  options: {},
  retry_strategy: function (options) {
    if (options.error && options.error.code === 'ECONNREFUSED') {
      // End reconnecting on a specific error and flush all commands with
      // a individual error
      return new Error('The server refused the connection');
    }

    if (options.total_retry_time > 1000 * 60 * 60) {
      // End reconnecting after a specific timeout and flush all commands
      // with a individual error
      return new Error('Retry time exhausted');
    }

    if (options.attempt > 10) {
      // End reconnecting with built in error
      return undefined;
    }

    // reconnect after
    return Math.min(options.attempt * 100, 3000);
  },
};

config.performance = {
  // PostgreSQL 'statement_timeout' for search queries in milliseconds (0 => no timeout)
  searchQueriesTimeout: 0,
};

config.postgres = {
  client: 'postgresql',
  connection: {
    host: 'localhost',
    port: 5432,
    database: 'freefeed',
    user: 'freefeed',
    password: 'freefeed',
  },
  pool: {
    min: 2,
    max: 10,
  },
  migrations: { tableName: 'knex_migrations' },
  textSearchConfigName: 'pg_catalog.russian',
};

/**
 * Fill this array with provider-specific credentials like:
 *
 * [
 *   {
 *     template: 'google',
 *     params: {
 *       clientId:     '####',
 *       clientSecret: '####',
 *     },
 *   },
 * ]
 *
 * See the **external-auth-providers.md** file in this dir for more information.
 */
config.externalAuthProviders = [];

const FBVersion = 'v8.0';
config.externalAuthTemplates = {
  google: {
    id: 'google',
    brand: 'google',
    title: 'Google',
    adapter: 'oauth2',
    params: { discoveryRoot: 'https://accounts.google.com' },
  },

  facebook: {
    id: 'facebook',
    brand: 'facebook',
    title: 'Facebook',
    adapter: 'oauth2',
    params: {
      authorizationEndpoint: `https://www.facebook.com/${FBVersion}/dialog/oauth`,
      tokenEndpoint: `https://graph.facebook.com/${FBVersion}/oauth/access_token`,
      userinfoEndpoint: `https://graph.facebook.com/${FBVersion}/me?fields=name,email,picture`,
      scope: 'email',
      userInfoFields: {
        id: 'id',
        name: 'name',
        email: 'email',
        pictureURL: 'picture.data.url',
      },
    },
  },

  github: {
    id: 'github',
    brand: 'github',
    title: 'GitHub',
    adapter: 'oauth2',
    params: {
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      userinfoEndpoint: 'https://api.github.com/user',
      scope: 'user:email',
      userInfoFields: {
        id: 'id',
        pictureURL: 'avatar_url',
      },
    },
  },
};

config.registrationsLimit = {
  interval: '1 day', // PostgreSQL 'interval' type syntax
  maxCount: 100,
};

config.search = {
  maxQueryComplexity: 30,
  minPrefixLength: 2,
};

config.maintenance = { messageFile: 'tmp/MAINTENANCE.txt' };

config.eslint = { linebreakStyle: null };

config.goneUsers = {
  //
  resumeTokenTTL: 600, // in seconds
};

config.jobManager = {
  pollInterval: 5, // in seconds
  jobLockTime: 120, // in seconds
  maxJobLockTime: 1800, // in seconds
  jobLockTimeMultiplier: 1.2,
  batchSize: 5,
};

config.userDeletion = {
  cooldownDays: 30, // in days
  reminderDays: 27, // in days
};

config.ianaTimeZone = 'Europe/Tallinn';

config.appTokens = {
  //
  activationCodeTTL: 300, // in seconds
};

config.authSessions = {
  usageDebounceSec: 30,
  reissueGraceIntervalSec: 300,
  // Cleanup
  activeSessionTTLDays: 60,
  inactiveSessionTTLDays: 7,
  cleanupIntervalSec: 3600, // one hour
};

config.maxLength = {
  post: 3000,
  comment: 3000,
  description: 1500,
};

config.passwordReset = {
  tokenBytesLength: 12,
  tokenTTL: 8 * 3600, // in seconds
};

config.shortLinks = {
  initialLength: {
    post: 6,
    comment: 4,
  },
  stopWords: ['dea', 'bad', 'bee', 'bab', 'fee', '666'],
  maxAttempts: 3, // max number of attempts (with DB uniqueness check) for selected length, before increasing the length by one
};

config.userPreferences = {
  /**
   * Default user preferences. This object must satisfy the JSON Schema defined
   * in app/models/user-prefs.ts
   *
   * It is not recommended to change these default values after creating a site
   * instance. Use 'overrides' to change the default values for new users.
   */
  defaults: {
    // Do not show comments with these hideType's (see Comment model constants)
    hideCommentsOfTypes: [],
    // Send notifications digest email for current user
    sendNotificationsDigest: true,
    // Send daily Best Of digest email for current user
    sendDailyBestOfDigest: false,
    // Send weekly Best Of digest email for current user
    sendWeeklyBestOfDigest: false,
    // Who to get direct messages from? ("all" or "friends", see User model constants)
    acceptDirectsFrom: 'friends',
    // Remove sensitive information (GPS, serial numbers, etc.) from media files
    sanitizeMediaMetadata: true,
    // Notify of all comments on my posts
    notifyOfCommentsOnMyPosts: false,
    // Notify of all comments on posts commented by me
    notifyOfCommentsOnCommentedPosts: false,
  },
  /**
   *  Here you can override the default values depending on the 'createdAt' time
   *  of user. The object key is a Lodash 'path' in the user preferences object.
   *
   * The 'createdBefore' and 'createdSince' are the only supported operators for
   * now.
   *
   * The example below means that for all accounts created since 2022-04-05, the
   * 'acceptDirectsFrom' has a "all" default value.
   */
  overrides: {
    // acceptDirectsFrom: { createdSince: '2022-04-05', value: "all" },
  },
};

config.loggly = {
  subdomain: '',
  token: '',
  tags: [],
};

config.emailVerification = {
  enabled: false,
  // Path to the file contains email domains that are not available for
  // inspection. These could be one-time email services or other unwanted hosts.
  //
  // File, if specified, must exists, or application will not start.
  //
  // It should be a plain text file, one domain suffix (!) per line. For
  // example, host.net will block addresses like user@host.net,
  // user@sub.host.net, but will not block user@otherhost.net.
  //
  // Spaces, blank lines and lines starting with "#" are ignored.
  domainBlockList: null,
  codes: {
    TTL: 3600, // in secs
    limitPerEmail: { count: 10, interval: 3600 },
    limitPerIP: { count: 30, interval: 24 * 3600 },
  },
};

config.rateLimit = {
  enabled: false,
  allowlist: ['::ffff:127.0.0.1'], // ip addresses or user ids
  anonymous: {
    duration: 'PT1M', // ISO 8601 duration
    maxRequests: {
      all: 10, // all methods
      GET: 100, // optional
    },
  },
  authenticated: {
    duration: 'PT1M', // ISO 8601 duration
    maxRequests: {
      all: 30,
      GET: 200,
      POST: 60,
    },
  },
  maskingKeyRotationInterval: 'P7D', // ISO 8601 duration
  blockDuration: 'PT1M', // duration of a block if threshold is breached
  repeatBlockCounterDuration: 'PT10M', // how long to remember about a breach
  repeatBlockMultiplier: 2, // block duration multiplier for repeated breaches
};

config.invitations = {
  requiredForSignUp: false, // When enabled, also turns off multiple-use invitations

  // On what conditions user can create invitations?
  // Use ISO8601 Duration format for time intervals.
  canCreateIf: [
    // [ "minAccountAge", { age: "P15D" } ],
    // [ "maxInvitesCreated", { count: 3, interval: "P1D" } ],
    // [ "maxInvitesCreated", { count: 60, interval: "P30D" } ],
    // [ "minPostsCreated", { count: 5 } ],
    // [ "minCommentsFromOthers", { count: 5 } ],
  ],
};

config.translation = {
  enabled: false,
  limits: {
    totalCharactersPerMonth: 500_000,
    userCharactersPerDay: 5_000,
  },
  service: 'google',
  serviceTitle: 'Google',
  apiKey: 'OVERRIDE_IT',
};

config.foldingInPosts = {
  headComments: 1, // Comments before omitted
  tailComments: 2, // Comments after omitted
  minOmittedComments: 2, // Minimum number of omitted comments
  headLikes: 3, // Likes before omitted
  minOmittedLikes: 2, // Minimum number of omitted likes
};

config.corsProxy = {
  // Timeout in ISO 8601 duration format
  timeout: 'PT5S',
  // The allowlist of request origins. 'none' is the special value that means
  // 'no Origin header' (for the case when the client and the server are on the
  // same host).
  allowedOrigins: ['none'],
  // Allow requests with any 'https?://localhost:*' origins (for local
  // development).
  allowLocalhostOrigins: true,
  // The allowlist of proxied URL prefixes.
  allowedUrlPrefixes: [],
};

module.exports = config;
