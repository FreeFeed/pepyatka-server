import XRegExp from 'xregexp';
import pgFormat from 'pg-format';
import config from 'config';
import { HASHTAG, LINK, MENTION } from 'social-text-tokenizer';

import { tokenize } from '../tokenize-text';

import { linkToText } from './norm';

const ftsCfg = config.postgres.textSearchConfigName;

export type Scope = 1 | 2 | 3;

export const IN_POSTS = 1 as Scope,
  IN_COMMENTS = 2 as Scope,
  IN_ALL = (IN_POSTS | IN_COMMENTS) as Scope;

export interface Token {
  getComplexity(): number;
}

/**
 * Pipe represents the pipe symbol (`|`). This token is used only on initial
 * parsing phase, the Pipe-joined Text tokens are converting to AnyText later.
 */
export class Pipe implements Token {
  getComplexity() {
    return 0;
  }
}

/**
 * Plus represents the plus symbol (`+`). This token is used only on initial
 * parsing phase, the Plus-joined tokens are converting to SeqTexts later.
 */
export class Plus implements Token {
  getComplexity() {
    return 0;
  }
}

/**
 * ScopeStart marks the start of global query scope.
 */
export class ScopeStart implements Token {
  constructor(public scope: Scope) {}

  getComplexity() {
    return 0;
  }
}

/**
 * Condition is the some post/comment non-textual filter.
 */
export class Condition implements Token {
  constructor(
    public exclude: boolean,
    public condition: string,
    public args: string[],
  ) {}

  getComplexity() {
    return 0.5 * this.args.length;
  }
}

/**
 * Text is a textual term: it may be a single word, mention, hashtag, double
 * quoted phrase. It is an atomic piece of query and have no internal elements.
 */
export class Text implements Token {
  constructor(
    public exclude: boolean,
    public phrase: boolean,
    public text: string,
  ) {}

  getComplexity() {
    return this.phrase ? this.text.split(/\s+/).length : 1;
  }

  toTSQuery() {
    const prefix = this.exclude ? '!!' : '';

    if (this.phrase) {
      const queries = tokenize(this.text)
        .map((token) => {
          if (token.type === HASHTAG || token.type === MENTION) {
            const exactText = token.type === HASHTAG ? token.text.replace(/[_-]/g, '') : token.text;
            return pgFormat(`%L::tsquery`, exactText);
          } else if (token.type === LINK) {
            return exactPhraseToTSQuery(linkToText(token.text));
          }

          return exactPhraseToTSQuery(token.text);
        })
        .filter(Boolean);

      if (queries.length === 0) {
        return "''";
      } else if (queries.length === 1) {
        return `${prefix}${queries[0]}`;
      }

      return `${prefix}(${queries.join('<->')})`;
    } else if (/^[#@]/.test(this.text)) {
      let exactText = this.text.charAt(0) === '#' ? this.text.replace(/[_-]/g, '') : this.text;

      if (/\*$/.test(this.text)) {
        exactText = `${exactText.substring(0, exactText.length - 1)}:*`;
      }

      return prefix + pgFormat(`%L::tsquery`, exactText);
    }

    const [firstToken] = tokenize(this.text);

    if (!firstToken) {
      return "''";
    }

    if (firstToken.type === LINK) {
      return prefix + pgFormat('phraseto_tsquery(%L, %L)', ftsCfg, linkToText(firstToken.text));
    }

    // Prefix search
    if (/\*$/.test(this.text)) {
      return prefix + pgFormat(`%L::tsquery`, `=${this.text.substring(0, this.text.length - 1)}:*`);
    }

    return prefix + pgFormat(`plainto_tsquery(%L, %L)`, ftsCfg, this.text);
  }
}

/**
 * AnyText contains one or more Text tokens. If there are more than one token,
 * the query will find any of them. But even a single Text must be wrapped in
 * AnyText.
 */
export class AnyText implements Token {
  constructor(public children: Text[]) {}

  getComplexity() {
    return this.children.reduce((acc, t) => acc + t.getComplexity(), 0);
  }

  toTSQuery() {
    const parts = this.children.map((t) => t.toTSQuery());
    return parts.length > 1 ? `(${parts.join(' || ')})` : parts[0];
  }
}

/**
 * SeqTexts contains one or more AnyText tokens. The query will find them in the
 * specific order. Even a single AnyText must be wrapped in SeqTexts.
 */
export class SeqTexts implements Token {
  constructor(public children: AnyText[]) {}

  getComplexity() {
    return this.children.reduce((acc, t) => acc + t.getComplexity(), 0);
  }

  toTSQuery() {
    const parts = this.children.map((t) => t.toTSQuery());
    return parts.length > 1 ? `(${parts.join(' <-> ')})` : parts[0];
  }
}

/**
 * InScope contains the subquery that have a specific local scope.
 */
export class InScope implements Token {
  constructor(
    public scope: Scope,
    public text: AnyText,
  ) {}

  getComplexity() {
    return this.text.getComplexity();
  }
}

export const scopeStarts: [RegExp, Scope][] = [
  [/^in-?body$/, IN_POSTS],
  [/^in-?comments?$/, IN_COMMENTS],
];

export const listConditions: [RegExp, string][] = [
  // Feeds
  [/^(in|groups?)$/, 'in'],
  [/^in-?my$/, 'in-my'],
  [/^commented-?by$/, 'commented-by'],
  [/^liked-?by$/, 'liked-by'],
  [/^to$/, 'to'],
  // Comments
  [/^cliked-?by$/, 'cliked-by'],
  // Authorship
  [/^from$/, 'from'],
  [/^authors?$/, 'author'],
  [/^by$/, 'author'], // synonym for "author"
];

export const dateConditions: [RegExp, string][] = [
  [/^date$/, 'date'],
  [/^post-?date$/, 'post-date'],
];

export const counterConditions: [RegExp, string][] = [
  [/^likes?$/, 'likes'],
  [/^comments?$/, 'comments'],
  [/^clikes?$/, 'clikes'],
];

// A simple trimmer, trims punctuation, separators and some symbols.
const trimTextRe = XRegExp(`^[\\pP\\pZ\\pC\\pS]*(.*?)[\\pP\\pZ\\pC\\pS]*$`, 'u');
const trimTextRightRe = XRegExp(`^(.*?)[\\pP\\pZ\\pC\\pS]*$`, 'u');

export type TrimTextOptions = {
  minPrefixLength: number;
};

export function trimText(text: string, { minPrefixLength }: TrimTextOptions) {
  if (/^[#@]/.test(text)) {
    if (text.endsWith('*')) {
      if (text.length <= minPrefixLength + 1) {
        throw new Error(`Minimum prefix length is ${minPrefixLength}`);
      }

      return `${text.replace(trimTextRightRe, '$1')}*`;
    }

    return text.replace(trimTextRightRe, '$1');
  }

  if (text.endsWith('*')) {
    if (text.length <= minPrefixLength) {
      throw new Error(`Minimum prefix length is ${minPrefixLength}`);
    }

    return `${text.replace(trimTextRe, '$1')}*`;
  }

  return text.replace(trimTextRe, '$1');
}

function exactPhraseToTSQuery(text: string): string {
  return pgFormat(
    `regexp_replace(phraseto_tsquery('simple', %L)::text, '''([^ ])', '''=\\1', 'g')::tsquery`,
    text,
  );
}
