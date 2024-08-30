import React from 'react';
import { default as URLFinder, shorten } from 'ff-url-finder';

import { LINK, AT_LINK, LOCAL_LINK, EMAIL, HASHTAG, ARROW, FRIENDFEED_POST } from './link-types';
import Link from './link.jsx';
import UserName from './user-name';

const MAX_URL_LENGTH = 50;

const finder = new URLFinder(
  ['ru', 'com', 'net', 'org', 'info', 'gov', 'edu', 'рф', 'ua'],
  ['freefeed.net', 'gamma.freefeed.net'],
);
finder.withHashTags = true;
finder.withArrows = true;

class Linkify extends React.Component {
  createLinkElement({ type }, displayedLink, href) {
    const props = { key: `match${++this.idx}`, dir: 'ltr' };

    if (type == AT_LINK || type == LOCAL_LINK) {
      props['to'] = href;

      return React.createElement(Link, props, displayedLink);
    } else if (type == HASHTAG) {
      props['to'] = href;

      return React.createElement(Link, props, displayedLink);
    } else if (type == ARROW) {
      props['className'] = 'arrow-span';

      return React.createElement('span', props, displayedLink);
    }

    // eslint-disable-line no-else-return
    if (href.match(FRIENDFEED_POST)) {
      props['className'] = 'archive-post';
      props['href'] = '#';
      return React.createElement('a', props, displayedLink);
    }

    props['href'] = href;
    props['target'] = '_blank';

    return React.createElement('a', props, displayedLink);
  }

  parseCounter = 0;
  idx = 0;

  parseString(string) {
    const elements = [];

    if (string === '') {
      return elements;
    }

    this.idx = 0;

    try {
      finder.parse(string).map((it) => {
        let displayedLink = it.text;
        let href;

        if (it.type === LINK) {
          displayedLink = shorten(it.text, MAX_URL_LENGTH).replace(/^https?:\/\//, '');
          href = it.url;
        } else if (it.type === AT_LINK) {
          elements.push(
            <UserName
              user={{ username: it.username }}
              display={it.text}
              me={new Object()}
              key={`match${++this.idx}`}
            />,
          );
          return;
        } else if (it.type === LOCAL_LINK) {
          displayedLink = shorten(it.text, MAX_URL_LENGTH).replace(/^https?:\/\//, '');
          href = it.uri;
        } else if (it.type === EMAIL) {
          href = `mailto:${it.address}`;
        } else if (it.type === HASHTAG) {
          it.type = LOCAL_LINK;
          href = `/search?qs=${encodeURIComponent(it.text)}`;
          displayedLink = <bdi>{displayedLink}</bdi>;
        } else if (it.type === ARROW) {
          // pass
        } else {
          elements.push(it.text);
          return;
        }

        const linkElement = this.createLinkElement(it, displayedLink, href);
        elements.push(linkElement);
      });

      return elements.length === 1 ? elements[0] : elements;
    } catch {
      // Do nothing
    }

    return [string];
  }

  parse(children) {
    let parsed = children;

    if (typeof children === 'string') {
      parsed = this.parseString(children);
    } else if (
      React.isValidElement(children) &&
      children.type !== 'a' &&
      children.type !== 'button'
    ) {
      parsed = React.cloneElement(
        children,
        { key: `parse${++this.parseCounter}` },
        this.parse(children.props.children),
      );
    } else if (children instanceof Array) {
      parsed = children.map((child) => {
        return this.parse(child);
      });
    }

    return parsed;
  }

  render() {
    this.parseCounter = 0;
    const parsedChildren = this.parse(this.props.children);

    return (
      <span className="Linkify" dir="auto">
        {parsedChildren}
      </span>
    );
  }
}

export default Linkify;
