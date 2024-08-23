/* eslint-env node, mocha */
import expect from 'unexpected';

import {
  AnyText,
  Text,
  Condition,
  ScopeStart,
  InScope,
  IN_COMMENTS,
  IN_POSTS,
  SeqTexts,
} from '../../../../app/support/search/query-tokens';
import { parseQuery, queryComplexity } from '../../../../app/support/search/parser';

describe('search:parseQuery', () => {
  const testData = [
    {
      query: '',
      result: [],
    },
    {
      query: 'a b c',
      result: [
        seqTexts(new Text(false, false, 'a')),
        seqTexts(new Text(false, false, 'b')),
        seqTexts(new Text(false, false, 'c')),
      ],
    },
    {
      query: 'a, #b: c!',
      comment: 'remove the extra punctuation',
      result: [
        seqTexts(new Text(false, false, 'a')),
        seqTexts(new Text(false, false, '#b')),
        seqTexts(new Text(false, false, 'c')),
      ],
    },
    {
      query: 'a | b | c',
      result: [
        new SeqTexts([
          anyText(
            new Text(false, false, 'a'),
            new Text(false, false, 'b'),
            new Text(false, false, 'c'),
          ),
        ]),
      ],
    },
    {
      query: 'a || | b |',
      comment: 'multiple | should be merged into one',
      result: [new SeqTexts([anyText(new Text(false, false, 'a'), new Text(false, false, 'b'))])],
    },
    {
      query: 'a | from:me',
      comment: '| near the operator should be ignored',
      result: [seqTexts(new Text(false, false, 'a')), new Condition(false, 'from', ['me'])],
    },
    {
      query: 'a + b',
      result: [seqTexts(new Text(false, false, 'a'), new Text(false, false, 'b'))],
    },
    {
      query: 'a ++ | b',
      result: [seqTexts(new Text(false, false, 'a'), new Text(false, false, 'b'))],
    },
    {
      query: 'a + b | c',
      result: [
        new SeqTexts([
          anyText(new Text(false, false, 'a')),
          anyText(new Text(false, false, 'b'), new Text(false, false, 'c')),
        ]),
      ],
    },
    {
      query: 'inmy:a,b -c',
      result: [new Condition(false, 'in-my', ['a', 'b']), seqTexts(new Text(true, false, 'c'))],
    },
    {
      query: 'inmy: -c',
      comment: 'inmy: should become text',
      result: [seqTexts(new Text(false, false, 'inmy')), seqTexts(new Text(true, false, 'c'))],
    },
    {
      query: 'inbody: in-comment:"a b"',
      result: [
        new ScopeStart(IN_POSTS),
        new InScope(IN_COMMENTS, anyText(new Text(false, true, 'a b'))),
      ],
    },
    {
      query: 'inbody: -in-comment:qwer',
      result: [
        new ScopeStart(IN_POSTS),
        new InScope(IN_COMMENTS, anyText(new Text(true, false, 'qwer'))),
      ],
    },
    {
      query: 'inbody: -in-comment:qwer,ty',
      result: [
        new ScopeStart(IN_POSTS),
        new InScope(IN_COMMENTS, anyText(new Text(true, false, 'qwer'))),
        new InScope(IN_COMMENTS, anyText(new Text(true, false, 'ty'))),
      ],
    },
    {
      query: 'inbody: in-comment:qwer,ty',
      result: [
        new ScopeStart(IN_POSTS),
        new InScope(
          IN_COMMENTS,
          anyText(new Text(false, false, 'qwer'), new Text(false, false, 'ty')),
        ),
      ],
    },
    // UUIDs
    {
      query: 'a b 123e4567-e89b-12d3-a456-426614174000',
      comment: 'UUID should become exact phrase',
      result: [
        seqTexts(new Text(false, false, 'a')),
        seqTexts(new Text(false, false, 'b')),
        seqTexts(new Text(false, true, '123e4567 e89b 12d3 a456 426614174000')),
      ],
    },
    {
      query: 'a b "123e4567-e89b-12d3-a456-426614174000"',
      comment: 'UUID should become exact phrase',
      result: [
        seqTexts(new Text(false, false, 'a')),
        seqTexts(new Text(false, false, 'b')),
        seqTexts(new Text(false, true, '123e4567 e89b 12d3 a456 426614174000')),
      ],
    },
    {
      query: 'inbody:123e4567-e89b-12d3-a456-426614174000',
      comment: 'UUID should become exact phrase',
      result: [
        new InScope(
          IN_POSTS,
          anyText(new Text(false, true, '123e4567 e89b 12d3 a456 426614174000')),
        ),
      ],
    },
    {
      query: 'foobar cliked-by:john',
      comment: 'cliked-by: creates a comment scope',
      result: [
        new ScopeStart(IN_COMMENTS),
        seqTexts(new Text(false, false, 'foobar')),
        new Condition(false, 'cliked-by', ['john']),
      ],
    },
    {
      query: 'in-comments: foobar cliked-by:john',
      comment: "cliked-by: doesn't creates additional scope",
      result: [
        new ScopeStart(IN_COMMENTS),
        seqTexts(new Text(false, false, 'foobar')),
        new Condition(false, 'cliked-by', ['john']),
      ],
    },
    {
      query: 'in-body: foobar cliked-by:john',
      comment: "cliked-by: doesn't work in body scope",
      result: [new ScopeStart(IN_POSTS), seqTexts(new Text(false, false, 'foobar'))],
    },
    {
      query: 'has:files -has:audio,images',
      comment: "cliked-by: doesn't work in body scope",
      result: [
        new Condition(false, 'has', ['file']),
        new Condition(true, 'has', ['audio', 'image']),
      ],
    },
  ];

  for (const { query, comment, result } of testData) {
    it(`should parse '${query}'${comment ? ` (${comment})` : ''}`, () => {
      expect(parseQuery(query), 'to equal', result);
    });
  }
});

describe('search:queryComplexity', () => {
  const testData = [
    { query: '', result: 0 },
    { query: 'foo', result: 1 },
    { query: 'foo bar from:me', result: 2.5 },
    { query: '"foo bar baz" from:me', result: 3.5 },
    { query: 'foo bar from:me,too', result: 3 },
    { query: 'the really | long and complex in-comment:query', result: 6 },
  ];

  for (const { query, result } of testData) {
    it(`should calculate the '${query}' compexity`, () => {
      expect(queryComplexity(parseQuery(query)), 'to be', result);
    });
  }
});

function anyText(...ts: Text[]) {
  return new AnyText(ts);
}

function seqTexts(...ts: Text[]) {
  return new SeqTexts(ts.map((t) => anyText(t)));
}
