import XRegExp from 'xregexp';
import { flow } from 'lodash';
import config from 'config';
import { validate as uuidValidate } from 'uuid';

import { normalizeText } from './norm';
import {
  scopeStarts,
  listConditions,
  ScopeStart,
  Pipe,
  Plus,
  Condition,
  Text,
  InScope,
  trimText,
  Token,
  SeqTexts,
  AnyText,
  IN_COMMENTS,
  dateConditions,
  counterConditions,
} from './query-tokens';
import { parseDateExpression } from './date-parser';
import { parseCounterExpression } from './counter-parser';

// -?(scope:)?(double-quoted-string|string)
const tokenRe = XRegExp(
  `
  (?:
    (?<pipe> \\|) |
    (?<plus> \\+) |
    (?:
      (?<exclude> -)?
      (?:(?<cond> [\\w-]+):)?
      (?:
        (?<qstring> "(?:[^"\\\\]|\\\\.)*") |
        (?<word> \\S+)
      )
    )
  )
`,
  'gx',
);

export type ParseQueryOptions = {
  minPrefixLength: number;
};

export function parseQuery(query: string, { minPrefixLength }: ParseQueryOptions = config.search) {
  // 1-st run: Split the query string into tokens

  const tokens = [] as Token[];

  XRegExp.forEach(normalizeText(query), tokenRe, (match) => {
    const [raw] = match;

    const { groups } = match;

    if (!groups) {
      // This should never happen, but TypeScript requires this check
      return;
    }

    if (groups.pipe) {
      tokens.push(new Pipe());
      return;
    }

    if (groups.plus) {
      tokens.push(new Plus());
      return;
    }

    // Handle UUIDs
    // UUID-like texts should become a space-separated phrase
    if (!groups.qstring && uuidValidate(groups.word)) {
      groups.qstring = JSON.stringify(groups.word.replace(/-/g, ' '));
      delete groups.word;
    } else if (groups.qstring && uuidValidate(groups.qstring.replace(/^"|"$/g, ''))) {
      groups.qstring = groups.qstring.replace(/-/g, ' ');
    }

    // in-body: (start of scope)
    if (/^[\w-]+:$/.test(raw)) {
      for (const [re, scope] of scopeStarts) {
        if (re.test(raw.substring(0, raw.length - 1))) {
          tokens.push(new ScopeStart(scope));
          return;
        }
      }
    }

    if (groups.cond) {
      // (-)in:saves,friends
      for (const [re, condition] of listConditions) {
        if (re.test(groups.cond)) {
          tokens.push(
            new Condition(
              !!groups.exclude,
              condition,
              groups.word
                .split(',')
                .map((w) => trimText(w, { minPrefixLength }))
                .filter(Boolean),
            ),
          );
          return;
        }
      }

      // (-)in-body:cat,mouse
      for (const [re, scope] of scopeStarts) {
        if (re.test(groups.cond)) {
          if (groups.qstring) {
            // in-body:"cat mouse" => "cat mouse"
            tokens.push(
              new InScope(
                scope,
                new AnyText([new Text(!!groups.exclude, true, JSON.parse(groups.qstring))]),
              ),
            );
          } else {
            const words = (groups.word as string)
              .split(',')
              .map((w) => trimText(w, { minPrefixLength }))
              .filter(Boolean);

            if (!groups.exclude) {
              // in-body:cat,mouse => cat || mouse
              const texts = words.map((word) => new Text(false, false, word));
              tokens.push(new InScope(scope, new AnyText(texts)));
            } else {
              // -in-body:cat,mouse => !cat && !mouse
              const texts = words.map((word) => new Text(true, false, word));
              tokens.push(...texts.map((t) => new InScope(scope, new AnyText([t]))));
            }
          }

          return;
        }
      }

      // (-)date:2020-01-01..2020-01-02
      for (const [re, condition] of dateConditions) {
        if (!re.test(groups.cond)) {
          continue;
        }

        const parsed = parseDateExpression(groups.word);

        if (!parsed) {
          break;
        }

        tokens.push(new Condition(!!groups.exclude, condition, parsed));
        return;
      }

      // has:images,audio
      if (groups.cond === 'has') {
        const validWords = ['image', 'audio', 'file'];
        const words = (groups.word as string)
          .split(',')
          .map((w) => w.replace(/s$/g, ''))
          .filter((w) => validWords.includes(w));
        tokens.push(new Condition(!!groups.exclude, 'has', words));
        return;
      }

      // (-)comments:2..12
      for (const [re, condition] of counterConditions) {
        if (!re.test(groups.cond)) {
          continue;
        }

        const parsed = parseCounterExpression(groups.word);

        if (!parsed) {
          break;
        }

        tokens.push(new Condition(!!groups.exclude, condition, parsed));
        return;
      }

      // Scope not found, treat as raw text
      tokens.push(
        new AnyText([new Text(!!groups.exclude, false, trimText(raw, { minPrefixLength }))]),
      );
      return;
    }

    // Just a text
    tokens.push(
      new AnyText([
        new Text(
          !!groups.exclude,
          !!groups.qstring,
          groups.qstring ? JSON.parse(groups.qstring) : trimText(groups.word, { minPrefixLength }),
        ),
      ]),
    );
  });

  {
    // Special case: the 'cliked-by:' operator creates an implicit in-comments:
    // scope if there is not one defined already.
    const clikedIdx = tokens.findIndex(
      (t) => t instanceof Condition && t.condition === 'cliked-by',
    );

    if (clikedIdx !== -1) {
      const scopeIdx = tokens.findLastIndex((t, i) => t instanceof ScopeStart && i < clikedIdx);

      if (scopeIdx === -1 || scopeIdx > clikedIdx) {
        // No scope defined before 'cliked-by:'
        tokens.unshift(new ScopeStart(IN_COMMENTS));
      } else if (tokens[scopeIdx] instanceof ScopeStart && tokens[scopeIdx].scope !== IN_COMMENTS) {
        // Scope defined before 'cliked-by:', but it's not IN_COMMENTS. Ignore 'cliked-by:' in this case.
        tokens.splice(clikedIdx, 1);
      }
    }
  }

  return flow([joinByPipes, joinByPluses])(tokens) as Token[];
}

export function queryComplexity(tokens: Token[]) {
  return tokens.reduce((acc, token) => acc + token.getComplexity(), 0);
}

// Token list post-processors

/**
 *  1-st run: Merge all "AnyText (Pipe AnyText)+" combinations into one
 *  AnyText.Result should not contain any Pipe's.
 */
function joinByPipes(tokens: Token[]) {
  const result = [] as Token[];
  let prevToken = null;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] instanceof Pipe) {
      if (!prevToken || !(prevToken instanceof AnyText)) {
        // Last inserted token is not an AnyText
        continue;
      }

      if (i < tokens.length - 1 && tokens[i + 1] instanceof AnyText) {
        // Next token is AnyText, join it with the prevToken
        prevToken.children.push(...(tokens[i + 1] as AnyText).children);
        // Jump over the joined token
        i++;
        continue;
      }
    } else {
      prevToken = tokens[i];
      result.push(prevToken);
    }
  }

  return result;
}

function joinByPluses(tokens: Token[]) {
  const result = [] as Token[];
  let prevToken = null;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] instanceof Plus) {
      if (!prevToken || !(prevToken instanceof SeqTexts)) {
        // Last inserted token is not an SeqTexts
        continue;
      }

      if (i < tokens.length - 1 && tokens[i + 1] instanceof AnyText) {
        // Next token is AnyText, join it with the prevToken
        prevToken.children.push(tokens[i + 1] as AnyText);
        // Jump over the joined token
        i++;
        continue;
      }
    } else {
      prevToken = tokens[i];

      if (prevToken instanceof AnyText) {
        prevToken = new SeqTexts([prevToken]);
      }

      result.push(prevToken);
    }
  }

  return result;
}
