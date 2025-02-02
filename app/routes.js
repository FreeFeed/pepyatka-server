/* eslint babel/semi: "error" */
import Router from '@koa/router';
import cors from '@koa/cors';

import AttachmentsRoute from './routes/api/v1/AttachmentsRoute';
import AttachmentsRouteV2 from './routes/api/v2/AttachmentsRoute';
import BookmarkletRoute from './routes/api/v1/BookmarkletRoute';
import CommentsRoute from './routes/api/v1/CommentsRoute';
import GroupsRoute from './routes/api/v1/GroupsRoute';
import PasswordsRoute from './routes/api/v1/PasswordsRoute';
import PostsRoute from './routes/api/v1/PostsRoute';
import SessionRoute from './routes/api/v1/SessionRoute';
import UsersRoute from './routes/api/v1/UsersRoute';
import GroupsRouteV2 from './routes/api/v2/GroupsRoute';
import RequestsRouteV2 from './routes/api/v2/RequestsRoute';
import SearchRoute from './routes/api/v2/SearchRoute';
import SummaryRoute from './routes/api/v2/SummaryRoute';
import CalendarRoute from './routes/api/v2/CalendarRoute';
import TimelinesRouteV2 from './routes/api/v2/TimelinesRoute';
import UsersRouteV2 from './routes/api/v2/UsersRoute';
import StatsRouteV2 from './routes/api/v2/Stats';
import ArchivesStatsRouteV2 from './routes/api/v2/ArchivesStats';
import PostsRouteV2 from './routes/api/v2/PostsRoute';
import ArchivesRoute from './routes/api/v2/ArchivesRoute';
import NotificationsRoute from './routes/api/v2/NotificationsRoute';
import CommentLikesRoute from './routes/api/v2/CommentLikesRoute';
import InvitationsRoute from './routes/api/v2/InvitationsRoute';
import AppTokensRoute from './routes/api/v2/AppTokens';
import ServerInfoRoute from './routes/api/v2/ServerInfo';
import ExtAuthRoute from './routes/api/v2/ExtAuth';
import CorsProxyRoute from './routes/api/v2/CorsProxyRoute';
import AdminCommonRoute from './routes/api/admin/CommonRoute';
import AdminAdminRoute from './routes/api/admin/AdminRoute';
import AdminModeratorRoute from './routes/api/admin/ModeratorRoute';
import { withJWT } from './controllers/middlewares/with-jwt';
import { withAuthToken } from './controllers/middlewares/with-auth-token';
import { apiNotFoundMiddleware } from './setup/initializers/api-not-found';
import { authRequired } from './controllers/middlewares';
import { rateLimiterMiddleware } from './support/rateLimiter';

export default function (app) {
  const router = createRouter();
  app.use(router.routes());
  app.use(router.allowedMethods());

  app.use(cors());
  app.use(apiNotFoundMiddleware);
}

export function createRouter() {
  const publicRouter = new Router();

  // unauthenticated routes
  PasswordsRoute(publicRouter);

  publicRouter.use(fixMatchedRouteMiddleware);

  // [at least optionally] authenticated routes
  publicRouter.use(withJWT);
  publicRouter.use(rateLimiterMiddleware);
  publicRouter.use(withAuthToken);

  SessionRoute(publicRouter);

  AttachmentsRoute(publicRouter);
  BookmarkletRoute(publicRouter);
  CommentsRoute(publicRouter);
  GroupsRoute(publicRouter);
  PostsRoute(publicRouter);
  UsersRouteV2(publicRouter);
  UsersRoute(publicRouter);
  StatsRouteV2(publicRouter);

  GroupsRouteV2(publicRouter);
  RequestsRouteV2(publicRouter);
  SearchRoute(publicRouter);
  SummaryRoute(publicRouter);
  CalendarRoute(publicRouter);
  TimelinesRouteV2(publicRouter);
  PostsRouteV2(publicRouter);
  ArchivesRoute(publicRouter);
  ArchivesStatsRouteV2(publicRouter);
  NotificationsRoute(publicRouter);
  CommentLikesRoute(publicRouter);
  InvitationsRoute(publicRouter);
  AppTokensRoute(publicRouter);
  ServerInfoRoute(publicRouter);
  ExtAuthRoute(publicRouter);
  AttachmentsRouteV2(publicRouter);
  CorsProxyRoute(publicRouter);

  const router = new Router();
  router.use('/v([1-9]\\d*)', publicRouter.routes(), publicRouter.allowedMethods());

  {
    const adminRouter = new Router();
    adminRouter.use(fixMatchedRouteMiddleware);
    adminRouter.use(withJWT);
    adminRouter.use(rateLimiterMiddleware);
    adminRouter.use(withAuthToken);
    adminRouter.use(authRequired());
    AdminCommonRoute(adminRouter);
    AdminAdminRoute(adminRouter);
    AdminModeratorRoute(adminRouter);
    router.use('/api/admin', adminRouter.routes(), adminRouter.allowedMethods());
  }

  return router;
}

// Fix for ctx._matchedRoute
// koa-router puts most generic instead of most specific route to the ctx._matchedRoute
// See https://github.com/ZijianHe/koa-router/issues/246
function fixMatchedRouteMiddleware(ctx, next) {
  ctx.state.matchedRoute = ctx.matched.find((layer) => layer.methods.includes(ctx.method)).path;
  return next();
}
