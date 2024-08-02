import { flatten, uniq } from 'lodash';
import config from 'config';
import createDebug from 'debug';
import pgFormat from 'pg-format';

import { parseQuery, queryComplexity } from '../search/parser';
import {
  IN_POSTS,
  IN_COMMENTS,
  Condition,
  IN_ALL,
  ScopeStart,
  InScope,
  SeqTexts,
} from '../search/query-tokens';
import { List } from '../open-lists';
import { Comment } from '../../models';

import { sqlIn, sqlIntarrayIn, andJoin, orJoin } from './utils';

///////////////////////////////////////////////////
// Search
///////////////////////////////////////////////////

const debug = createDebug('freefeed:searchEngine');

const searchTrait = (superClass) =>
  class extends superClass {
    async search(
      query,
      {
        viewerId = null,
        limit = 30,
        offset = 0,
        sort = 'bumped',
        maxQueryComplexity = config.search.maxQueryComplexity,
      } = {},
    ) {
      const parsedQuery = parseQuery(query);

      if (queryComplexity(parsedQuery) > maxQueryComplexity) {
        throw new Error(`The search query is too complex, try to simplify it`);
      }

      if (!viewerId && parsedQuery.some((t) => t instanceof Condition && t.condition === 'in-my')) {
        throw new Error(`Please sign in to use 'in-my:' filter`);
      }

      /**
       * There are three search scopes:
       * - IN_ALL (default scope, search something in posts OR in comments)
       * - IN_POSTS (search something in posts only)
       * - IN_COMMENTS (search something in comments only)
       *
       * These scopes produces a corresponding conditions that joins by AND.
       * IN_ALL query, in turn, consists of two sub-conditions, for 'posts' and
       * for 'comments' tables, joined by OR. Also we have additional
       * restrictions for the posts (privacy and bans) and comments (hideType
       * and bans). So the resulting query is looks like:
       *
       * ((Posts_inAll AND Posts_restr) OR (Comments_inAll AND Comments_restr))
       * AND (Posts_inPosts AND Posts_restr) AND (Comments_inComments AND
       * Comments_restr)
       *
       * Using the UNION statement instead of explicit OR we can write this
       * request in the following form:
       *
       * Posts_inAll AND Posts_inPosts
       * AND Comments_inComments AND Posts_restr AND Comments_restr
       * UNION
       * Comments_inAll
       * AND Comments_inComments AND Posts_restr AND Comments_restr
       *
       * It is the full form of request but in practice it may be simple. For
       * example, if query uses only the IN_ALL scope we have:
       *
       * Posts_inAll AND Posts_restr
       * UNION
       * Comments_inAll AND Posts_restr AND Comments_restr
       */

      // Map from username to User/Group object (or null)
      const accounts = await this._getAccountsUsedInQuery(parsedQuery, viewerId);

      // Authorship
      const allContentAuthors = getAuthorNames(parsedQuery, IN_ALL);
      let postAuthors = getAuthorNames(parsedQuery, IN_POSTS);
      const commentAuthors = getAuthorNames(parsedQuery, IN_COMMENTS);
      const clikesAuthors = getClikesAuthorNames(parsedQuery);

      for (const list of [allContentAuthors, postAuthors, commentAuthors]) {
        list.items = list.items.map((name) => accounts[name] && accounts[name].id).filter(Boolean);
      }

      // Comment likes requires integer ids of users
      clikesAuthors.items = clikesAuthors.items
        .map((name) => accounts[name] && accounts[name].intId)
        .filter(Boolean);

      // Posts feeds
      const postsFeedIdsLists = await this._getFeedIdsLists(parsedQuery, accounts);

      // Special case: in-my:discussions
      //
      // The in-my:discussions filter is effectively a "commented-by:me | liked-by:me |
      // posts-from:me". But the first two parts are feeds and the last is an authorship, so we can
      // not express this in one simple form and must process the "| posts-from:me" part separately.
      let orPostsFromMe = false;

      for (const token of parsedQuery) {
        if (
          token instanceof Condition &&
          token.condition === 'in-my' &&
          token.args.some((a) => /discussion/.test(a))
        ) {
          if (token.exclude) {
            // ! (| posts-from:me) === & (!posts-from:me)
            postAuthors = List.intersection(postAuthors, new List([viewerId], false));
          } else {
            orPostsFromMe = true;
          }
        }
      }

      // Text search
      const inAllTSQuery = getTSQuery(parsedQuery, IN_ALL);
      const inPostsTSQuery = getTSQuery(parsedQuery, IN_POSTS);
      const inCommentsTSQuery = getTSQuery(parsedQuery, IN_COMMENTS);

      // Create partial SQL queries
      const inAllPostsSQL = andJoin([
        inAllTSQuery && `p.body_tsvector @@ ${inAllTSQuery}`,
        sqlIn('p.user_id', allContentAuthors),
      ]);

      const inAllCommentsSQL = andJoin([
        inAllTSQuery && `c.body_tsvector @@ ${inAllTSQuery}`,
        sqlIn('c.user_id', allContentAuthors),
      ]);

      let postsFeedsSQL = andJoin([
        ...postsFeedIdsLists.map((list) => sqlIntarrayIn('p.feed_ids', list)),
      ]);

      // Special hack for in-my:discussions
      if (orPostsFromMe) {
        postsFeedsSQL = orJoin([postsFeedsSQL, pgFormat('p.user_id=%L', viewerId)], 'true');
      }

      const inPostsSQL = andJoin([
        inPostsTSQuery && `p.body_tsvector @@ ${inPostsTSQuery}`,
        sqlIn('p.user_id', postAuthors),
        postsFeedsSQL,
      ]);

      const inCommentsSQL = andJoin([
        inCommentsTSQuery && `c.body_tsvector @@ ${inCommentsTSQuery}`,
        sqlIn('c.user_id', commentAuthors),
      ]);

      // Are we using the 'comment_likes' table?
      const useClikesTable = !clikesAuthors.isEverything();
      // Are we using the 'comments' table?
      const useCommentsTable =
        inAllCommentsSQL !== 'true' || inCommentsSQL !== 'true' || useClikesTable;

      // Additional restrictions for comments
      let commentsRestrictionSQL = 'true';

      if (useCommentsTable) {
        const notBannedSQLFabric = await this.notBannedActionsSQLFabric(viewerId);
        commentsRestrictionSQL = andJoin([
          pgFormat('c.hide_type=%L', Comment.VISIBLE),
          notBannedSQLFabric('c'),
          useClikesTable &&
            orJoin([
              !clikesAuthors.inclusive && 'cl.user_id is null',
              sqlIn('cl.user_id', clikesAuthors),
            ]),
        ]);
      }

      // Additional restrictions for posts
      const postsRestrictionsSQL = await this.postsVisibilitySQL(viewerId);

      // Now we building the full query
      const postsPart = andJoin([
        inAllPostsSQL,
        // inPostsSQL, // Using as CTE (see fullSQL below)
        postsRestrictionsSQL,
        inCommentsSQL,
        inCommentsSQL !== 'true' && commentsRestrictionSQL,
      ]);
      const commentsPart =
        useCommentsTable &&
        andJoin([
          inAllCommentsSQL,
          // inPostsSQL, // Using as CTE (see fullSQL below)
          postsRestrictionsSQL,
          inCommentsSQL,
          commentsRestrictionSQL,
        ]);

      const fullPostsSQL = [
        `select p.uid, p.${sort}_at as date from posts p `,
        `join users u on p.user_id = u.uid`,
        inCommentsSQL !== 'true' && 'left join comments c on c.post_id = p.uid',
        useClikesTable && `left join comment_likes cl on cl.comment_id = c.id`,
        `where ${postsPart}`,
      ]
        .filter(Boolean)
        .join(' ');

      const fullCommentsSQL =
        useCommentsTable &&
        `select p.uid, p.${sort}_at as date from posts p join users u on p.user_id = u.uid ` +
          ` join comments c on c.post_id = p.uid ` +
          ` ${useClikesTable ? `left join comment_likes cl on cl.comment_id = c.id` : ``} ` +
          ` where ${commentsPart} `;

      const pgVersion = await this.getPGVersion();

      const fullSQL = [
        // Use CTE here for better performance. PostgreSQL optimizer cannot
        // properly optimize conditions like `where feed_ids && '{111}' and
        // user_id <> '222-222-222'`. It is better to filter `feed_ids &&` first
        // and `user_id <>` later. We force this order using the CTE (inPostsSQL
        // is mostly about `feed_ids &&` conditions).
        inPostsSQL !== 'true' &&
          `with posts as ${
            pgVersion >= 120000 ? 'materialized' : ''
          } (select * from posts p where ${inPostsSQL})`,
        fullPostsSQL,
        fullCommentsSQL && `union\n${fullCommentsSQL}`,
        `order by date desc limit ${+limit} offset ${+offset}`,
      ]
        .filter(Boolean)
        .join('\n');

      debug(fullSQL);

      return (await this.database.raw(fullSQL)).rows.map((r) => r.uid);
    }

    async _getAccountsUsedInQuery(parsedQuery, viewerId) {
      const conditionsWithAccNames = [
        'in',
        'commented-by',
        'liked-by',
        'cliked-by',
        'from',
        'author',
        'to',
      ];

      // Map from username to User/Group object (or null)
      const accounts = { me: viewerId && (await this.getFeedOwnerById(viewerId)) };

      let accountNames = [];

      for (const token of parsedQuery) {
        if (token instanceof Condition && conditionsWithAccNames.includes(token.condition)) {
          if (!viewerId && token.args.includes('me')) {
            throw new Error(`Please sign in to use 'me' as username`);
          }

          token.args = token.args.map((n) => (n === 'me' ? accounts.me.username : n));
          accountNames.push(...token.args);
        }
      }

      accountNames = uniq(accountNames);

      const accountObjects = await this.getFeedOwnersByUsernames(accountNames);

      for (const ao of accountObjects) {
        accounts[ao.username] = ao;
      }

      for (const name of accountNames) {
        if (!accounts[name]) {
          accounts[name] = null;
        }
      }

      return accounts;
    }

    /**
     * Post can belongs to many feeds, so this function returns an array of Lists of feed intId's.
     *
     * @param {Array} tokens
     * @param {Object} accountsMap
     * @returns {Promise<Array>}
     */
    async _getFeedIdsLists(tokens, accountsMap) {
      const condToFeedNames = {
        in: 'Posts',
        'commented-by': 'Comments',
        'liked-by': 'Likes',
      };
      // For gone users only the Comments feed is available (comments aren't
      // deleted when user gone)
      const goneUsersFeeds = ['Comments'];
      const myFeedNames = ['saves', 'directs', 'discussions', 'friends'];

      return await Promise.all(
        tokens
          .filter(
            (t) =>
              t instanceof Condition &&
              (!!condToFeedNames[t.condition] || t.condition === 'in-my' || t.condition === 'to'),
          )
          .map(async (t) => {
            const feedName = condToFeedNames[t.condition];

            // in:, commented-by:, liked-by:
            if (feedName) {
              const userIds = uniq(t.args)
                .map((n) => accountsMap[n])
                .filter((u) => u && (u.isActive || goneUsersFeeds.includes(feedName)))
                .map((u) => u.id);

              const feedIntIds = await this.getUsersNamedFeedsIntIds(userIds, [feedName]);
              return new List(feedIntIds, !t.exclude);
            }

            if (t.condition === 'to') {
              const userIds = uniq(t.args)
                .map((n) => accountsMap[n])
                .filter((u) => u?.isUser())
                .map((u) => u.id);

              const groupIds = uniq(t.args)
                .map((n) => accountsMap[n])
                .filter((u) => u?.isActive && u.isGroup())
                .map((u) => u.id);

              const feedIntIds = flatten(
                await Promise.all([
                  this.getUsersNamedFeedsIntIds(userIds, ['Directs']),
                  this.getUsersNamedFeedsIntIds(groupIds, ['Posts']),
                ]),
              );
              return new List(feedIntIds, !t.exclude);
            }

            // in-my:
            const currentUser = accountsMap['me'];
            const feedIntIds = await Promise.all(
              uniq(t.args)
                .map((n) => (/s$/i.test(n) ? n : `${n}s`))
                .filter((n) => myFeedNames.includes(n))
                .map(async (name) => {
                  switch (name) {
                    case 'saves': {
                      return [await currentUser.getGenericTimelineIntId('Saves')];
                    }
                    case 'directs': {
                      return [await currentUser.getGenericTimelineIntId('Directs')];
                    }
                    case 'discussions': {
                      return await Promise.all([
                        currentUser.getCommentsTimelineIntId(),
                        currentUser.getLikesTimelineIntId(),
                      ]);
                    }
                    case 'friends': {
                      const homeFeed = await currentUser.getRiverOfNewsTimeline();
                      const { destinations } = await this.getSubscriprionsIntIds(homeFeed);
                      return destinations;
                    }
                  }

                  return [];
                }),
            );
            return new List(feedIntIds, !t.exclude);
          }),
      );
    }
  };

export default searchTrait;

function walkWithScope(tokens, action) {
  let currentScope = IN_ALL;

  for (const token of tokens) {
    if (token instanceof ScopeStart) {
      currentScope = token.scope;
      continue;
    }

    action(token, currentScope);
  }
}

function getTSQuery(tokens, targetScope) {
  const result = [];

  walkWithScope(tokens, (token, currentScope) => {
    if (token instanceof SeqTexts && currentScope === targetScope) {
      result.push(token.toTSQuery());
    }

    if (token instanceof InScope && token.scope === targetScope) {
      result.push(token.text.toTSQuery());
    }
  });

  return result.length > 1 ? `(${result.join(' && ')})` : result.join(' && ');
}

function getAuthorNames(tokens, targetScope) {
  let result = List.everything();

  walkWithScope(tokens, (token, currentScope) => {
    if (
      token instanceof Condition &&
      ((token.condition === 'from' && targetScope === IN_POSTS) ||
        (token.condition === 'author' && targetScope === currentScope))
    ) {
      result = List.intersection(result, token.exclude ? List.inverse(token.args) : token.args);
    }
  });

  return result;
}

function getClikesAuthorNames(tokens) {
  let result = List.everything();

  walkWithScope(tokens, (token, currentScope) => {
    if (
      currentScope === IN_COMMENTS &&
      token instanceof Condition &&
      token.condition === 'cliked-by'
    ) {
      result = List.intersection(result, token.exclude ? List.inverse(token.args) : token.args);
    }
  });

  return result;
}
