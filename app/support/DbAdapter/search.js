import { flatten, union, uniq } from 'lodash';
import config from 'config';
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

import { sqlIn, sqlIntarrayIn, andJoin, orJoin, sqlInOrNull, sqlNot } from './utils';

/**
 * @typedef {import('../search/query-tokens').Token} Token
 */

///////////////////////////////////////////////////
// Search
///////////////////////////////////////////////////

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

      // Map from username to User/Group object (or null)
      const accountsMap = await this._getAccountsUsedInQuery(parsedQuery, viewerId);

      // Text queries
      const commonTextQuery = getTSQuery(parsedQuery, IN_ALL); // Search for this text in posts and comments
      const postsOnlyTextQuery = getTSQuery(parsedQuery, IN_POSTS); // Search for this text only in posts
      const commentsOnlyTextQuery = getTSQuery(parsedQuery, IN_COMMENTS); // Search for this text only in comments

      // Authorship
      const commonAuthors = namesToIds(getAuthorNames(parsedQuery, IN_ALL), accountsMap);
      let postOnlyAuthors = namesToIds(getAuthorNames(parsedQuery, IN_POSTS), accountsMap);
      const commentOnlyAuthors = namesToIds(getAuthorNames(parsedQuery, IN_COMMENTS), accountsMap);

      // Date
      const commonDateSQL = orJoin([
        dateFiltersSQL(parsedQuery, 'p.created_at', IN_ALL),
        dateFiltersSQL(parsedQuery, 'c.created_at', IN_ALL),
      ]);
      const postDateSQL = dateFiltersSQL(parsedQuery, 'p.created_at', IN_POSTS);
      const commentDateSQL = dateFiltersSQL(parsedQuery, 'c.created_at', IN_COMMENTS);

      // Files
      const fileTypesSQL = fileTypesFiltersSQL(parsedQuery, 'a');
      const useFilesTable = fileTypesSQL !== 'true' && fileTypesSQL !== 'false';

      // Posts elements

      // Posts feeds
      const postsFeedIdsLists = await this._getFeedIdsLists(parsedQuery, accountsMap);
      let postsFeedsSQL = andJoin(
        postsFeedIdsLists.map((list) => sqlIntarrayIn('p.feed_ids', list)),
      );

      // Privacy restrictions for posts
      const postsRestrictionsSQL = await this.postsVisibilitySQL(viewerId);

      // Special case: in-my:discussions
      //
      // The in-my:discussions filter is effectively a "commented-by:me | liked-by:me |
      // posts-from:me". But the first two parts are feeds and the last is an authorship, so we can
      // not express this in one simple form and must process the "| posts-from:me" part separately.
      const orPostsFromMe = orPostsFromMeState(parsedQuery);

      if (orPostsFromMe !== null) {
        if (orPostsFromMe) {
          postsFeedsSQL = orJoin([postsFeedsSQL, pgFormat('p.user_id=%L', viewerId)]);
        } else {
          postOnlyAuthors = List.intersection(postOnlyAuthors, new List([viewerId], false));
        }
      }

      // Comments elements

      // CLiked-by
      const cLikesAuthors = namesToIntIds(getClikesAuthorNames(parsedQuery), accountsMap);

      // Are we using the 'comment_likes' table?
      const useCLikesTable = !cLikesAuthors.isEverything();
      // Are we using the 'comments' table?
      const useCommentsTable =
        !!commentsOnlyTextQuery ||
        !!commonTextQuery ||
        !commentOnlyAuthors.isEverything() ||
        !commonAuthors.isEverything() ||
        useCLikesTable ||
        commonDateSQL !== 'true' ||
        commentDateSQL !== 'true';

      // Privacy restrictions for comments
      let commentsRestrictionSQL = 'true';

      if (useCommentsTable) {
        const notBannedSQLFabric = await this.notBannedActionsSQLFabric(viewerId);
        commentsRestrictionSQL = andJoin([
          pgFormat('(c.hide_type is null or c.hide_type=%L)', Comment.VISIBLE),
          notBannedSQLFabric('c'),
        ]);
      }

      // Building the full query

      const textSQL = andJoin([
        commonTextQuery &&
          orJoin([
            `p.body_tsvector @@ ${commonTextQuery}`,
            `c.body_tsvector @@ ${commonTextQuery}`,
          ]),
        postsOnlyTextQuery && `p.body_tsvector @@ ${postsOnlyTextQuery}`,
        commentsOnlyTextQuery && `c.body_tsvector @@ ${commentsOnlyTextQuery}`,
      ]);

      const authorsSQL = andJoin([
        commonAuthors &&
          orJoin([sqlIn('p.user_id', commonAuthors), sqlIn('c.user_id', commonAuthors)]),
        postOnlyAuthors && sqlIn('p.user_id', postOnlyAuthors),
        commentOnlyAuthors && sqlIn('c.user_id', commentOnlyAuthors),
      ]);

      const dateSQL = andJoin([commonDateSQL, postDateSQL, commentDateSQL]);

      const fullSQL = [
        // Use CTE here for better performance. PostgreSQL optimizer cannot
        // properly optimize conditions like `where feed_ids && '{111}' and
        // user_id <> '222-222-222'`. It is better to filter `feed_ids &&` first
        // and `user_id <>` later. We force this order using the CTE
        // (postsFeedsSQL is mostly about `feed_ids &&` conditions).
        postsFeedsSQL !== 'true' &&
          `with posts as materialized (select * from posts p where ${postsFeedsSQL})`,

        `select p.uid, p.${sort}_at as date`,
        `from posts p`,
        `join users u on p.user_id = u.uid`,
        useCommentsTable && `left join comments c on c.post_id = p.uid`,
        useCLikesTable && `left join comment_likes cl on cl.comment_id = c.id`,
        useFilesTable && `left join attachments a on a.post_id = p.uid`,
        `where`,
        andJoin([
          textSQL,
          authorsSQL,
          dateSQL,
          postsRestrictionsSQL,
          commentsRestrictionSQL,
          useCLikesTable && sqlInOrNull('cl.user_id', cLikesAuthors),
        ]),
        `group by p.uid, p.${sort}_at`,
        `having ${fileTypesSQL}`,
        `order by date desc limit ${+limit} offset ${+offset}`,
      ]
        .filter(Boolean)
        .join('\n');

      // console.log(fullSQL);

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
     * A post can belong to multiple feeds, so this function returns an array of Lists of feed intIds.
     * Post can belongs to many feeds, so this function returns an array of Lists of feed intId's.
     *
     * @param {Token[]} tokens
     * @param {Object} accountsMap
     * @returns {Promise<List<number>[]>}
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

function dateFiltersSQL(tokens, field, targetScope) {
  const result = [];
  walkWithScope(tokens, (token, currentScope) => {
    if (
      token instanceof Condition &&
      ((token.condition === 'post-date' && targetScope === IN_POSTS) ||
        (token.condition === 'date' && currentScope === targetScope))
    ) {
      result.push(
        `${field} ${token.exclude ? 'not ' : ''}between '${token.args[0]}' and '${token.args[1]}'`,
      );
    }
  });
  return andJoin(result);
}

const validFileTypes = ['audio', 'image', 'general'];
/**
 * Returns aggregated List of file types used in 'has:' conditions. Returns null
 * if none of such conditions present.
 *
 * @param {Token[]} tokens
 * @returns {[string[]|null, string[]|null]}
 */
function getFileTypes(tokens) {
  /** @type {string[]|null}  */
  let positive = null;
  /** @type {string[]|null}  */
  let negative = null;

  for (const token of tokens) {
    if (!(token instanceof Condition) || token.condition !== 'has') {
      continue;
    }

    // Select only the valid file types
    const argTypes = token.args
      // The 'file' type means 'audio, image, or general'
      .flatMap((a) => (a === 'file' ? validFileTypes : a))
      .filter((a) => validFileTypes.includes(a));

    if (!token.exclude) {
      positive = positive ? union(positive, argTypes) : uniq(argTypes);
    } else {
      negative = negative ? union(negative, argTypes) : uniq(argTypes);
    }
  }

  return [positive, negative];
}

/**
 * @param {string[]} types
 * @param {string} attTable
 * @returns {string|null}
 */
function fileTypesToAggregate(types, attTable) {
  if (types.length === validFileTypes.length) {
    // Any type is valid
    return `bool_or(${attTable}.media_type is not null)`;
  }

  return `bool_or(${orJoin(types.map((t) => `${attTable}.media_type = '${t}'`))})`;
}

function fileTypesFiltersSQL(tokens, attTable) {
  const [positiveTypes, negativeTypes] = getFileTypes(tokens);

  return andJoin([
    positiveTypes && fileTypesToAggregate(positiveTypes, attTable),
    negativeTypes && sqlNot(fileTypesToAggregate(negativeTypes, attTable)),
  ]);
}

/**
 * @param {Token[]} tokens
 * @returns {boolean|null} null if not found, true if "OR from:me", false if
 * "AND NOT from:me"
 */
function orPostsFromMeState(tokens) {
  for (const token of tokens) {
    if (
      token instanceof Condition &&
      token.condition === 'in-my' &&
      token.args.some((a) => /discussion/.test(a))
    ) {
      // ! (| posts-from:me) === & (!posts-from:me)
      return !token.exclude;
    }
  }

  return null;
}

function namesToIds(list, accountsMap) {
  list.items = list.items.map((name) => accountsMap[name] && accountsMap[name].id).filter(Boolean);
  return list;
}

function namesToIntIds(list, accountsMap) {
  list.items = list.items
    .map((name) => accountsMap[name] && accountsMap[name].intId)
    .filter(Boolean);
  return list;
}
