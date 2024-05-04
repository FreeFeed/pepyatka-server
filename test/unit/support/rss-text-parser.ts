/* eslint-env node, mocha */
import config from 'config';
import expect from 'unexpected';

import { extractTitle, textToHTML } from '../../../app/support/rss-text-parser';

describe('extractTitle function', () => {
  const maxLen = 35;

  const testData = [
    [
      'should return the first line of text',
      'Tiger, tiger, burning bright\nIn the forests of the night',
      'Tiger, tiger, burning bright',
    ],
    [
      'should return the first sentence (without final period) of long line',
      'Tiger, tiger, burning bright. In the forests of the night',
      'Tiger, tiger, burning bright',
    ],
    [
      'should split a long sentence',
      'Tiger, tiger, burning bright In the forests of the night, What immortal hand or eye Could frame thy fearful symmetry?',
      'Tiger, tiger, burning bright In the\u2026',
    ],
    [
      'should cut a long word',
      'TigertigerburningbrightIntheforestsofthenight',
      'TigertigerburningbrightIntheforest\u2026',
    ],
    [
      'should stop on first sentence',
      'Tiger! Tiger burning bright in the forests of the night. What immortal?',
      'Tiger!',
    ],
    [
      'should stop on second sentence',
      'Tiger! Tiger burning bright! In the forests of the night, What immortal?',
      'Tiger! Tiger burning bright!',
    ],
  ];

  for (const [title, text, result] of testData) {
    it(title, () => expect(extractTitle(text, maxLen), 'to be', result));
  }
});

describe('textToHTML function', () => {
  it('should format text', () => {
    const input = `Tiger, @tiger, burning bright
      In the forests of the night,<br>
      What immortal.com hand or eye
      Dare frame thy fearful #symmetry?`;
    const expected = `<p>Tiger, <a href="${config.host}/tiger">@tiger</a>, burning bright<br />
In the forests of the night,&lt;br&gt;<br />
What <a href="https://immortal.com/">immortal.com</a> hand or eye<br />
Dare frame thy fearful <a href="${config.host}/search?qs=%23symmetry">#symmetry</a>?</p>`;
    expect(textToHTML(input), 'to be', expected);
  });
});
