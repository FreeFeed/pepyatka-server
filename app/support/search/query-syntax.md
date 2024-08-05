# Search query syntax

The search query is a sequence of text terms and search operators.

You can put the minus sign (`-`) right before the text term or operator to _exclude_ it from search results: `cat -mouse` will return documents with the "cat" word but without the "mouse" word.

## Text terms

The text term is a word without white spaces (like `cat`, or `#mouse` or even `http://freefeed.net/`) or a double-quoted string that can include spaces: `"cat mouse"`. Putting text in double quotes tells search engine to search these words in the specific order and in exact word forms. It is also possible to search words by prefix (not in double quotes): `cat*`.

By default _all_ text terms in query will be searched (AND is implied). You can use the "pipe" symbol (`|`) to search _any_ of them: `cat | mouse` will find documents with "cat" OR with "mouse". To search words in the specific order use the "plus" symbol (`+`): `cat + mouse` means these two words standing next to each other in that order.

Two important rules about the `+` and `|` symbols:

1. The `|` symbol has the highest priority: `cat mouse | dog` means 'the documents with "cat" AND ("mouse" OR "dog")'; `cat + mouse | dog` means 'the documents with "cat" FOLLOWED_BY ("mouse" OR "dog")'.
2. The AND symbol has the lowest priority: `cat + mouse dog` means 'the documents with ("cat" FOLLOWED_BY "mouse") AND "dog"'.
3. You can use the `|` and `+` symbols only between the text terms, not with the other operators.

## Operators

General rule: in any operator you can omit dash symbol (if present) and the 's suffix of the plural word form. For example the `in-comments:` operator can also be written as `incomments:` or `incomment:`.

Some operators takes user name as an arguments. In such operators you can use a special user name, `me` that means you, the current signed in user. The `cat from:me` query will find the "cat" word in all posts and comments of the current user.

### Full operators list

* in-body:
* in-comments:
* from:
* author: / by:
* in:
* in-my:
* commented-by:
* liked-by:
* clicked-by:
* to:
* date:
* post-date:


### Global search scope

⚠ Warning: you can not use minus modifier with global search scope operators.

By default, the search is performed both in post and comment bodies. The following operators changes this behavior.

**in-body:** — starting from this operator the search will be performed only in the post bodies. 

Example: `cat in-body: mouse` — the "cat" will be searched in posts and comments but the "mouse" will be searched only in post bodies. Note that there's a space after a colon because "in-body:" is a separate operator here.

**in-comments:** — starting from this operator the search will be performed only in the comment bodies.

Example: `in-comments: mouse` — the "mouse" will be searched only in comment bodies.

The global search scope operators switches search scope from itself to the end of the query or to the other global scope operator. 

### Local search scope

Local search scope operator are like global ones but without switching the global search scope.

**in-body:word1,word2** or **in-body:"quoted text"** will search _any_ of word1, word2 or the "quoted text" in post body but will not change the global query scope. Note that there is no space after a colon.

**in-comments:word1,word2** or **in-comments:"quoted text"** do the same for comments.

Example: `cat in-body:mouse dog` — the "cat" and "dog" will be searched in post and comments but the "mouse" will be searched only in posts.

### Content filtering

**from:user1,user2** limits search to posts authored by user1 or user2. The `from:alice cat` query will search "cat" in posts authored by Alice _and in any their comments_ (not only in Alice's comments').

**in:user1,group2** limits search to posts published in user1 or group2 feeds.

`cat in:cats` will find all post with the "cat" word in the @cats group.

`cat in:cats from:alice` will find all post with the "cat" word authored by Alice in the @cats group.

`cat in:cats,alice` will find all post with the "cat" word posted to the Alice's own feed OR to the @cats group.

`cat in:cats in:alice` will find all post with the "cat" word posted to the Alice's own feed AND to the @cats group.

The "in:" operator has the "group:" alias, it left for compatibility.

**in-my:feed1,feed2** limit search to the current user's personal feeds. The personal feed names are: "saves", "directs", "discussions" and "friends". You can omit the 's suffix in these names. The "friends" feed means all feeds of users and groups current user subscribed to.

`cat in-my:saves` will find all post with the "cat" word in my Saves feed.

**commented-by:user1,user2** limits search to posts commented by user1 or user2.

`cat commented-by:alice` will find all posts with the "cat" word (in body or in any comments) among the posts commented by Alice.

**liked-by:user1,user2** limits search to posts liked by user1 or user2.

`cat liked-by:alice` will find all posts liked by Alice with the "cat" word.

**to:user1,group2** limits search to posts published in group2 feed or written _to_ user1 as a direct message. This operator acts like **in:** for the groups but also allows to search in direct messages with the specific addressee.

**clicked-by:user1,user2** limits search to comments licked by user1 or user2.

`cat clicked-by:alice` will find all comments liked by Alice with the "cat" word.

Since `clicked-by:` makes sense only for comments, it switches the search scope to comments. So the query `cat clicked-by:alice` is equal to `in-comments: cat clicked-by:alice`. Being used in post body scope (like `in-body: clicked-by:...`), `clicked-by:` is ignored.

**date:YYYY-MM-DD** and **post-date:YYYY-MM-DD** limits search to content published on the specified date. 

The `date:` operator defines the date of the content being searched. The `foo date:2020-01-01` will search the "foo" word in posts published on 2020-01-01 or in comments published on 2020-01-01 (even if the post date is different).

The `post-date:` always sets the post date. The `in-comments: foo post-date:2020-01-01` will search the "foo" word in comments to posts published on 2020-01-01.

`date:` and `post-date:` are **interval operators**, they are allow you to specify date intervals. Let `D` is a date in the format `YYYY-MM-DD`:
* `date:D` will search content published on the date `D`
* `date:=D` is the same as `date:D`
* `date:<D` will search content published on the date before `D`
* `date:>D` will search content published on the date after `D`
* `date:<=D` will search content published on the date before or on `D`
* `date:>=D` will search content published on the date after or on `D`
* `date:D1..D2` will search content published on the date between `D1` and `D2` (inclusive)
* `date:D..*` is the same as `date:>=D`
* `date:*..D` is the same as `date:<=D`

### Content authorship

**author:user1,user2** performs search only in content from user1 or user2. It has a **by:** alias.

The "content" is defined by the current search scope. By default it is a post and comment bodies: `cat author:alice` will search the "cat" word in all Alice's posts and comments bodies.

`in-body: author:alice cat` will search the "cat" word only in Alice's posts bodies. In this context the 'author:' works in same way as 'from:'.

`in-comments: author:alice cat` will search the "cat" word only in Alice's comments bodies.
