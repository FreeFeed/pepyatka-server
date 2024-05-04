/* eslint babel/semi: "error" */
import http from 'http';
import util from 'util';

import AwaitLock from 'await-lock';
import createDebug from 'debug';

import FreefeedApp from './freefeed-app';
import routesInit from './routes';
import PubsubListener from './pubsub-listener';
import { initJobProcessing } from './jobs';
import { init as initEnvironment } from './setup/environment';

let app = null;

const lock = new AwaitLock();

/**
 * @returns {Promise<FreefeedApp>}
 */
export async function getSingleton() {
  if (app !== null) {
    return app;
  }

  await lock.acquireAsync();

  try {
    if (app !== null) {
      return app;
    }

    await initEnvironment();

    const _app = new FreefeedApp();
    routesInit(_app);
    await initJobProcessing(_app);

    const server = http.createServer(_app.callback());
    const listen = util.promisify(server.listen).bind(server);

    _app.context.pubsub = new PubsubListener(server, _app);

    const port = getListeningPort(_app);
    await listen(port);
    // The actual port
    _app.context.port = server.address().port;

    const log = createDebug('freefeed:init');

    log(`Koa server is listening on port ${port}`);
    log(`Server is running in ${_app.env} mode`);

    app = _app;

    return app;
  } finally {
    lock.release();
  }
}

function getListeningPort(_app) {
  let port = validPortValue(process.env.PEPYATKA_SERVER_PORT);

  if (port === undefined) {
    port = validPortValue(process.env.PORT);
  }

  if (port === undefined) {
    port = validPortValue(_app.context.config.port);
  }

  return port ?? 0;
}

function validPortValue(port) {
  if (typeof port === 'number' && port >= 0 && port < 65536) {
    return port;
  }

  return undefined;
}
