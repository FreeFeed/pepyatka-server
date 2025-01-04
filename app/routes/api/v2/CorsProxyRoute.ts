import type Router from '@koa/router';

import { proxy } from '../../../controllers/api/v2/CorsProxyController';

export default function addRoutes(app: Router) {
  app.get('/cors-proxy', proxy);
}
