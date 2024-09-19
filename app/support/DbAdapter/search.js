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

import { sqlIn, sqlIntarrayIn, andJoin, orJoin, sqlNot } from './utils';

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

      if (!viewerId && parsedQuery.some((t) => isCondition(t, 'in-my'))) {
        throw new Error(`Please sign in to use 'in-my:' filter`);
      }

      let hasPostTokens = false;
      let hasCommentTokens = false;
      walkWithScope(parsedQuery, (token, currentScope) => {
        if (currentScope & IN_POSTS) {
          hasPostTokens = true;
        }

        if (currentScope & IN_COMMENTS) {
          hasCommentTokens = true;
        }
      });

      // Map from username to User/Group object (or null)
      const accountsMap = await this._getAccountsUsedInQuery(parsedQuery, viewerId);

      // Text queries
      const commonTextQuery = getTSQuery(parsedQuery, IN_ALL); // Search for this text in posts and comments
      const postsOnlyTextQuery = getTSQuery(parsedQuery, IN_POSTS); // Search for this text only in posts
      const commentsOnlyTextQuery = getTSQuery(parsedQuery, IN_COMMENTS); // Search for this text only in comments

      // Text authorship (the 'author:'/'by:' filter)
      const commonTextAuthors = namesToIds(getAuthorNames(parsedQuery, IN_ALL), accountsMap);
      const postTextAuthors = namesToIds(getAuthorNames(parsedQuery, IN_POSTS), accountsMap);
      const commentTextAuthors = namesToIds(getAuthorNames(parsedQuery, IN_COMMENTS), accountsMap);

      // Post author filter (the 'from:' filter)
      let postAuthors = namesToIds(getPostAuthorNames(parsedQuery), accountsMap);

      // Date
      const postsContentDateSQL = andJoin([
        contendDateSQL(parsedQuery, 'p.created_at', IN_ALL),
        contendDateSQL(parsedQuery, 'p.created_at', IN_POSTS),
      ]);
      const commentsContentDateSQL = andJoin([
        contendDateSQL(parsedQuery, 'c.created_at', IN_ALL),
        contendDateSQL(parsedQuery, 'c.created_at', IN_COMMENTS),
      ]);

      const postsDateSQL = postDateFilterSQL(parsedQuery, 'p.created_at');

      // Files
      const fileTypesSQL = fileTypesFiltersSQL(parsedQuery, 'a');
      const useFilesTable = isNonTrivialSQL(fileTypesSQL);

      // Posts privacy flags
      const postsPrivacySQL = privacyFiltersSQL(parsedQuery, 'p');

      // Counters
      const postCountersSQL = andJoin([
        countersFiltersSQL(parsedQuery, 'comments', 'pc.comments_count'),
        countersFiltersSQL(parsedQuery, 'likes', 'pc.likes_count'),
      ]);
      const usePostCountersTable = isNonTrivialSQL(postCountersSQL);

      const commentCountersSQL = countersFiltersSQL(parsedQuery, 'clikes', 'cc.likes_count');
      const useCommentCountersTable = isNonTrivialSQL(commentCountersSQL);

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
          postAuthors = List.intersection(postAuthors, new List([viewerId], false));
        }
      }

      // Comments elements

      // CLiked-by
      const cLikesSQL = getClikesAuthorsSQL(parsedQuery, 'cl.user_id', accountsMap);
      const useCLikesTable = isNonTrivialSQL(cLikesSQL);

      // Privacy restrictions for comments
      let commentsRestrictionSQL = 'true';

      if (hasCommentTokens) {
        const notBannedSQLFabric = await this.notBannedActionsSQLFabric(viewerId);
        commentsRestrictionSQL = orJoin([
          'c.id is null',
          andJoin([pgFormat('c.hide_type=%L', Comment.VISIBLE), notBannedSQLFabric('c')]),
        ]);
      }

      /**
       * Text queries:
       *
       * The text query logic is the following:
       *
       *     (p.body_tsvector @@ commonQuery OR c.body_tsvector @@ commonQuery)
       *     AND p.body_tsvector @@ postsOnlyQuery
       *     AND c.body_tsvector @@ commentsOnlyQuery
       *
       * PostgreSQL is not very good at optimizing in such cases, so we replace
       * OR with two queries with UNION:
       *
       *     p.body_tsvector @@ commonQuery
       *     AND p.body_tsvector @@ postsOnlyQuery
       *     AND c.body_tsvector @@ commentsOnlyQuery
       *       UNION
       *     c.body_tsvector @@ commonQuery
       *     AND p.body_tsvector @@ postsOnlyQuery
       *     AND c.body_tsvector @@ commentsOnlyQuery
       */

      const postsPartTextSQL = andJoin([
        commonTextQuery && `p.body_tsvector @@ ${commonTextQuery}`,
        postsOnlyTextQuery && `p.body_tsvector @@ ${postsOnlyTextQuery}`,
        commentsOnlyTextQuery && `c.body_tsvector @@ ${commentsOnlyTextQuery}`,
      ]);

      const commentsPartTextSQL = andJoin([
        commonTextQuery && `c.body_tsvector @@ ${commonTextQuery}`,
        postsOnlyTextQuery && `p.body_tsvector @@ ${postsOnlyTextQuery}`,
        commentsOnlyTextQuery && `c.body_tsvector @@ ${commentsOnlyTextQuery}`,
      ]);

      // Authors
      const postTextsAuthorsSQL = andJoin([
        commonTextAuthors && sqlIn('p.user_id', commonTextAuthors),
        postTextAuthors && sqlIn('p.user_id', postTextAuthors),
      ]);

      const commentTextsAuthorsSQL = andJoin([
        commonTextAuthors && sqlIn('c.user_id', commonTextAuthors),
        commentTextAuthors && sqlIn('c.user_id', commentTextAuthors),
      ]);

      const postsAuthorsFilterSQL = andJoin([postAuthors && sqlIn('p.user_id', postAuthors)]);

      // Building the full query

      const fromSQL = joinLines([
        `from posts p`,
        `join users u on p.user_id = u.uid`,
        hasCommentTokens && `left join comments c on c.post_id = p.uid`,
        useCLikesTable && `left join comment_likes cl on cl.comment_id = c.id`,
        useFilesTable && `left join attachments a on a.post_id = p.uid`,
        usePostCountersTable && `join post_counters pc on pc.post_id = p.uid`,
        useCommentCountersTable && `join comment_counters cc on cc.comment_id = c.uid`,
      ]);

      const commonWhereSQL = andJoin([
        postsAuthorsFilterSQL,
        postsDateSQL,
        postsRestrictionsSQL,
        commentsRestrictionSQL,
        postCountersSQL,
        commentCountersSQL,
        postsPrivacySQL,
      ]);

      const [postsPartQuery, commentsPartQuery] = [
        andJoin([postsPartTextSQL, postTextsAuthorsSQL, postsContentDateSQL]),
        andJoin([commentsPartTextSQL, commentTextsAuthorsSQL, commentsContentDateSQL]),
      ].map((partSQL) =>
        // The selecting query is almost the same for both UNION's members, the
        // difference is only in the partSQL condition
        joinLines([
          `select p.uid, p.${sort}_at as date, p.id`,
          fromSQL,
          `where`,
          andJoin([partSQL, commonWhereSQL]),
          `group by p.uid, p.${sort}_at, p.id`,
          `having ${andJoin([fileTypesSQL, cLikesSQL])}`,
        ]),
      );

      const fullSQL = joinLines([
        // Use CTE here for better performance. PostgreSQL optimizer cannot
        // properly optimize conditions like `where feed_ids && '{111}' and
        // user_id <> '222-222-222'`. It is better to filter `feed_ids &&` first
        // and `user_id <>` later. We force this order using the CTE
        // (postsFeedsSQL is mostly about `feed_ids &&` conditions).
        postsFeedsSQL !== 'true' &&
          `with posts as materialized (select * from posts p where ${postsFeedsSQL})`,

        joinLines(
          [
            (hasPostTokens || !hasCommentTokens) && postsPartQuery,
            hasCommentTokens && commentsPartQuery,
          ],
          'union',
        ),
        `order by date desc, id desc limit ${+limit} offset ${+offset}`,
      ]);

      // console.log(fullSQL);

      return this.database.getCol(fullSQL);
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

    action(token, token instanceof InScope ? token.scope : currentScope);
  }
}

function walkInScope(tokens, scope, action) {
  walkWithScope(tokens, (token, currentScope) => currentScope === scope && action(token));
}

function isCondition(token, condition) {
  return token instanceof Condition && token.condition === condition;
}

function getTSQuery(tokens, targetScope) {
  const result = [];

  walkInScope(tokens, targetScope, (token) => {
    if (token instanceof SeqTexts) {
      result.push(token.toTSQuery());
    }

    if (token instanceof InScope) {
      result.push(token.text.toTSQuery());
    }
  });

  return result.length > 1 ? `(${result.join(' && ')})` : result.join(' && ');
}

function getAuthorNames(tokens, targetScope) {
  let result = List.everything();

  walkInScope(tokens, targetScope, (token) => {
    if (isCondition(token, 'author')) {
      result = List.intersection(result, token.exclude ? List.inverse(token.args) : token.args);
    }
  });

  return result;
}

function getPostAuthorNames(tokens) {
  let result = List.everything();

  for (const token of tokens) {
    if (isCondition(token, 'from')) {
      result = List.intersection(result, token.exclude ? List.inverse(token.args) : token.args);
    }
  }

  return result;
}

function getClikesAuthorsSQL(tokens, field, accountsMap) {
  let positive = null;
  let negative = null;

  walkInScope(tokens, IN_COMMENTS, (token) => {
    if (isCondition(token, 'cliked-by')) {
      if (!token.exclude) {
        positive = positive ? union(positive, token.args) : uniq(token.args);
      } else {
        negative = negative ? union(negative, token.args) : uniq(token.args);
      }
    }
  });

  if (positive) {
    positive = positive.map((n) => accountsMap[n]?.intId).filter(Boolean);
  }

  if (negative) {
    negative = negative.map((n) => accountsMap[n]?.intId).filter(Boolean);
  }

  const positiveAgg = positive && `bool_or(${orJoin(positive.map((id) => `${field} = ${id}`))})`;
  const negativeAgg = negative && `bool_or(${orJoin(negative.map((id) => `${field} = ${id}`))})`;
  return andJoin([positiveAgg && positiveAgg, negativeAgg && sqlNot(negativeAgg)]);
}

function postDateFilterSQL(tokens, field) {
  const result = [];

  for (const token of tokens) {
    if (isCondition(token, 'post-date')) {
      result.push(intervalSQL(token, field));
    }
  }

  return andJoin(result);
}

function contendDateSQL(tokens, field, targetScope) {
  const result = [];
  walkWithScope(tokens, (token, currentScope) => {
    if (
      (isCondition(token, 'post-date') && targetScope === IN_POSTS) ||
      (isCondition(token, 'date') && currentScope === targetScope)
    ) {
      result.push(intervalSQL(token, field));
    }
  });
  return andJoin(result);
}

function privacyFiltersSQL(tokens, postsTable) {
  const privacyWords = ['public', 'private', 'protected'];
  let positive = null;
  let negative = null;

  for (const token of tokens) {
    if (!isCondition(token, 'is')) {
      continue;
    }

    const words = token.args.filter((w) => privacyWords.includes(w));

    if (!token.exclude) {
      positive = positive ? union(positive, words) : uniq(words);
    } else {
      negative = negative ? union(negative, words) : uniq(words);
    }
  }

  return andJoin([
    positive && orJoin(positive.map((p) => privacySQLCondition(p, postsTable))),
    negative && sqlNot(orJoin(negative.map((p) => privacySQLCondition(p, postsTable)))),
  ]);
}

/**
 * @param {'public' | 'private' | 'protected'} privacyWord
 * @param {string} postsTable
 * @returns {string}
 */
function privacySQLCondition(privacyWord, postsTable) {
  if (privacyWord === 'public') {
    return `not ${postsTable}.is_protected`;
  } else if (privacyWord === 'protected') {
    return `${postsTable}.is_protected and not ${postsTable}.is_private`;
  }

  return `${postsTable}.is_private`;
}

function countersFiltersSQL(tokens, condition, field) {
  const result = [];

  for (const token of tokens) {
    if (isCondition(token, condition)) {
      result.push(intervalSQL(token, field));
    }
  }

  return andJoin(result);
}

function intervalSQL(token, field) {
  const [start, end] = token.args;

  if (start && end) {
    return pgFormat(`${field} %s between %L and %L`, token.exclude ? 'not' : '', start, end);
  } else if (start) {
    return pgFormat(`${field} %s %L`, token.exclude ? '<' : '>=', start);
  } else if (end) {
    return pgFormat(`${field} %s %L`, token.exclude ? '>' : '<=', end);
  }

  return 'false';
}

const commonFileTypes = ['audio', 'image', 'general'];
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
    if (!isCondition(token, 'has')) {
      continue;
    }

    // Select only the valid file types
    const argTypes = token.args
      // The 'file' type means 'audio, image, or general'
      .flatMap((a) => (a === 'file' ? commonFileTypes : a))
      .filter((a) => commonFileTypes.includes(a) || a.startsWith('.'));

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
  if (commonFileTypes.every((t) => types.includes(t))) {
    // Any type is valid
    return `bool_or(${attTable}.media_type is not null)`;
  }

  return `bool_or(${orJoin(
    types.map((t) => {
      if (t.startsWith('.')) {
        // This is a file extension
        return pgFormat(
          `lower(reverse(split_part(reverse(${attTable}.file_name), '.', 1))) = %L`,
          t.replace(/^\./, ''),
        );
      }

      // This is a media type
      return pgFormat(`${attTable}.media_type = %L`, t);
    }),
  )})`;
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
    if (isCondition(token, 'in-my') && token.args.some((a) => /discussion/.test(a))) {
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

function isNonTrivialSQL(sql) {
  return sql && sql !== 'true' && sql !== 'false';
}

function joinLines(textLines, joiner = '') {
  return textLines.filter(Boolean).join(joiner ? `\n${joiner}\n` : '\n');
}
