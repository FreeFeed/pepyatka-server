import fs, { promises as fsPromises } from 'fs';

import passport from 'koa-passport';
import Raven from 'raven';
import createDebug from 'debug';
import config from 'config';

import { setSearchConfig as setPostgresSearchConfig } from './postgres';
import { init as passportInit } from './initializers/passport';
import { addLogglyToDebug } from './loggly';

addLogglyToDebug();

// Always print these namespaces to stderr in non-test environment
if (process.env.NODE_ENV !== 'test') {
  createDebug.enable(
    [
      'freefeed:init',
      'freefeed:*error*',
      'freefeed:*critical*',
      'freefeed:*fail*',
      process.env.DEBUG,
    ]
      .filter(Boolean)
      .join(','),
  );
}

const sentryIsEnabled = 'sentryDsn' in config;

if (sentryIsEnabled) {
  Raven.config(config.sentryDsn, { autoBreadcrumbs: true }).install();
}

const log = createDebug('freefeed:init');
process.env.MONITOR_PREFIX = config.monitorPrefix;

passportInit(passport);

const checkIfMediaDirectoriesExist = async () => {
  let gotErrors = false;

  const attachmentsDir = config.attachments.storage.rootDir + config.attachments.path;

  try {
    await fsPromises.access(attachmentsDir, fs.W_OK);
  } catch {
    gotErrors = true;
    log(`Attachments dir does not exist: ${attachmentsDir}`);
  }

  const checkPromises = Object.values(config.attachments.imageSizes).map(async (sizeConfig) => {
    const thumbnailsDir = config.attachments.storage.rootDir + sizeConfig.path;

    try {
      await fsPromises.access(thumbnailsDir, fs.W_OK);
    } catch {
      gotErrors = true;
      log(`Thumbnails dir does not exist: ${thumbnailsDir}`);
    }
  });
  await Promise.all(checkPromises);

  if (gotErrors) {
    throw new Error(`some of required directories are missing`);
  }
};

export const init = async function () {
  if (!config.secret) {
    process.stderr.write(`⛔ Configuration error: config.secret is not defined\n`);
    process.stderr.write(`\n`);
    process.stderr.write(`It is required to configure site secret before starting the server.\n`);
    process.stderr.write(`Use the FRFS_SECRET environment variable or set the "secret" key in\n`);
    process.stderr.write(`config/local* file (see https://github.com/lorenwest/node-config for\n`);
    process.stderr.write(`configuration help). Use long random string for the secret.\n`);
    process.stderr.write(`\n`);
    process.stderr.write(`Server cannot be started without the secret.\n`);
    process.stderr.write(`\n`);
    process.exit(1);
  }

  await setPostgresSearchConfig();

  if (config.media.storage.type === 'fs') {
    await checkIfMediaDirectoriesExist();
  }
};
