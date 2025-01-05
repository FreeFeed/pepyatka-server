// We cannot use regular 'import' in the ambient module
type ISO8601DurationString = import('../app/support/types').ISO8601DurationString;
type InvitationCreationCriterion =
  import('../app/support/types/invitations').InvitationCreationCriterion;

/**
 * Override config to match our configuration shape. This file is to be complete
 * as the code is translated to TypeScript.
 */
declare module 'config' {
  export type Config = {
    siteTitle: string;
    host: string;
    port: number;
    secret: string;
    appRoot: string;
    trustProxyHeaders: boolean;
    proxyIpHeader: string;
    logResponseTime: boolean;
    adminEmail: string;
    media: { supportedExtensions: string[] };
    attachments: {
      url: string;
      path: string;
      fileSizeLimit: number;
      maxCount: number;
      imageSizes: Record<
        string,
        {
          path: string;
          bounds: {
            width: number;
            height: number;
          };
        }
      >;
      storage: {
        rootDir: string;
      };
      sanitizeMetadata: {
        removeTags: RegExp[];
        ignoreTags: RegExp[];
      };
      useImgProxy: boolean;
    };
    maintenance: {
      messageFile: string;
    };

    recaptcha: {
      enabled: boolean;
      secret: string;
    };

    postgres: {
      textSearchConfigName: string;
    };

    search: {
      maxQueryComplexity: number;
      minPrefixLength: number;
    };

    company: {
      title: string;
      address: string;
    };

    database: number;
    redis: {
      host: string;
      port: number;
    };

    sentryDsn?: string;

    authSessions: {
      usageDebounceSec: number;
      reissueGraceIntervalSec: number;
      activeSessionTTLDays: number;
      inactiveSessionTTLDays: number;
      cleanupIntervalSec: number;
    };

    maxLength: {
      post: number;
      comment: number;
      description: number;
    };

    passwordReset: {
      tokenBytesLength: number;
      tokenTTL: number;
    };

    shortLinks: {
      initialLength: {
        post: number;
        comment: number;
      };
      stopWords: string[];
      maxAttempts: number;
    };

    jobManager: {
      pollInterval: number;
      jobLockTime: number;
      maxJobLockTime: number;
      jobLockTimeMultiplier: number;
      batchSize: number;
    };

    userPreferences: {
      defaults: {
        hideCommentsOfTypes: number[];
        sendNotificationsDigest: boolean;
        sendDailyBestOfDigest: boolean;
        sendWeeklyBestOfDigest: boolean;
        acceptDirectsFrom: string;
        sanitizeMediaMetadata: boolean;
        notifyOfCommentsOnMyPosts: boolean;
        notifyOfCommentsOnCommentedPosts: boolean;
      };
      overrides: {
        [k: string]:
          | { createdSince: string; value: unknown }
          | { createdBefore: string; value: unknown };
      };
    };

    mailer: {
      dailyBestOfDigestMailSubject: string;
      weeklyBestOfDigestMailSubject: string;
      notificationDigestEmailSubject: string;
    };

    loggly: {
      subdomain: string;
      token: string;
      tags: string[];
    };

    emailVerification: {
      enabled: boolean;
      domainBlockList: string | null;
      codes: {
        TTL: number;
        limitPerEmail: { count: number; interval: number };
        limitPerIP: { count: number; interval: number };
      };
    };

    rateLimit: {
      enabled: boolean;
      allowlist: string[];
      anonymous: {
        duration: ISO8601DurationString;
        maxRequests: number;
        methodOverrides?: Record<
          string,
          { duration?: ISO8601DurationString; maxRequests?: number }
        >;
      };
      authenticated: {
        duration: ISO8601DurationString;
        maxRequests: number;
        methodOverrides?: Record<
          string,
          { duration?: ISO8601DurationString; maxRequests?: number }
        >;
      };
      maskingKeyRotationInterval: ISO8601DurationString;
    };

    ianaTimeZone: string;

    invitations: {
      requiredForSignUp: boolean;
      canCreateIf: InvitationCreationCriterion[];
    };

    translation:
      | { enabled: false }
      | ({
          enabled: true;
          limits: TranslationLimits;
          serviceTitle: string;
        } & ({ service: 'test' } | { service: 'google'; apiKey: string }));

    foldingInPosts: {
      headComments: number;
      tailComments: number;
      minOmittedComments: number;
      headLikes: number;
      minOmittedLikes: number;
    };

    corsProxy: {
      timeout: ISO8601DurationString;
      allowedOrigins: string[];
      allowedUrlPrefixes: string[];
      allowLocalhostOrigins: boolean;
    };
  };

  export type TranslationLimits = {
    totalCharactersPerMonth: number;
    userCharactersPerDay: number;
  };

  const c: Config;
  export default c;
}
