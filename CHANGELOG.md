# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.23.0] - Not released
### Changed
- The media files (attachments) handling algorithm has been changed. There are
  four media types now: 'image', 'video', 'audio' and 'general'. Images are
  accepted in JPEG, PNG, WebP, GIF, HEIC/HEIF and AVIF formats. Also now we
  accept and process arbitrary formats of video and audio files (detected with
  ffmpeg).

  For the visual files (images and videos), the multiple preview sizes are
  created, in addition to the legacy 'thumbnail' and 'thumbnail2'.

  The animated GIF images are now treated as video files and the video previews
  are created for them.

  We don't keep the originals for the truly (not from animated images) video
  files. After the preview creation, the largest preview is kept as the
  'original'.

  Some media files (the truly video ones for now) are processed asynchronously.
  Right after they are uploaded to the server, the asynchronous job is
  scheduled, and after the job finishes, the 'attachment:update' realtime event
  is sent to the 'user:{ownerId}', 'attachment:{attachmentId}' and
  'post:{postId}' (if the file is attached to a post) channels.

  The `attachments` table now has a few new columns:
  - `width` and `height`: size of the original image or video file in pixels
    (null for non-visual files)
  - `duration`: duration of the video or audio in seconds (null for non-playable
    files)
  - `previews`: JSON object with preview types and sizes, see the
    _MediaPreviews_ type in the
    [app/support/media-files/types.ts](app/support/media-files/types.ts) file.
  - `meta`: JSON object with temporary or not essential media metadata. It can
    contain the audio/video title, album title and author name (in 'dc:title',
    'dc:relation.isPartOf' and 'dc:creator' fields, respectively) and some
    special flags:
    - `animatedImage`: true if the video was created from an animated image
    - `silent`: true if the video has no audio track
    - `inProgress`: true if the media file is currently being processed
### Added
- The new V4 API version is introduced, to support the new attachment features.
  See the new serialized attachment type `SerializedAttachmentV4` in the
  [app/serializers/v2/attachment.ts](app/serializers/v2/attachment.ts) file.
- The new `GET /vN/attachments/:attId` API endpoint returns the attachment by
  its ID.
- The new `POST /vN/attachments/byIds` API endpoint returns attachments by their
  IDs. Request body: `{"ids": [...]}`. Response body: `{ "attachments": [...],
  "users": [...], "idsNotFound": [...] }`.
- The new `GET /vN/attachments/:attId/:type` API endpoint returns the preview or
  the original of the attachment. The _type_ parameter can be 'original',
  'image', 'video' or 'audio'. The returned data is a JSON object with the following
  fields:
  - _url_ - the URL of the preview/original file
  - _mimeType_ - the MIME type of the preview/original file
  - _width_ and _height_ (optional) - the size in pixels if the file is visual
  
  This endpoint accepts the following query parameters (all optional):
  - _width_ and _height_ - the desired 'image'/'video' preview size in pixels
  - _format_ - the desired 'image' preview format: 'jpeg', 'webp', 'avif'
  - _redirect_ - if present, the response will be a 302 redirect to the file
  
  The server will choose the best available preview to fill the given size. It
  is not guaranteed that the returned preview will be of the requested size and
  format, but it will be as close as possible.
- Allow to limit the number of simultaneous executions for some job types.

  The JobManager now has a `limitedJobs` parameter of type `Record<string,
  number>`, that defines the maximum number of simultaneous executions for each
  job of given type (name). Other jobs, that are not listed in `limitedJobs` are
  executed without limits.

## [2.22.5] - 2025-01-05
### Added
- New API method `GET /v2/cors-proxy?url=...`. This method acts as a simple
  proxy for web clients that need to make requests to other origins
  (specifically, to oEmbed endpoints of media providers). The proxy is
  deliberately limited: the valid request origins and URL prefixes are defined
  in the server config (see the _corsProxy_ config entry).

## [2.22.4] - 2024-12-04
### Changed
- The `GET /v2/users/sparseMatches?qs=...`  API endpoint now returns private
  users and groups when the username _exactly matches_ the query string.
### Fixed
- Remove all the IFD1 metadata (the thumbnail) from the image after rotation.
  When the thumbnail data is broken (it is possible on some smartphone images),
  it prevents the updated image from being saved.

## [2.22.3] - 2024-09-19
### Fixed
- The 'by:' and 'date:' search operators were not working properly, they are
  fixed now.

## [2.22.2] - 2024-09-02

## [2.22.1] - 2024-08-31
### Added
- The new `is:` search operator
### Changed
- The `has` search operator now accepts file extensions (as in `has:pdf` or
  `has:.pdf`)

## [2.22.0] - 2024-08-30
### Added
- New search operators:
  - `cliked-by:`
  - `has:`
  - `comments:`
  - `likes:`
  - `clikes:`
  - `date:`
  - `post-date:`

  See [app/support/search/query-syntax.md](app/support/search/query-syntax.md)
  for details.

## [2.21.0] - 2024-06-25
### Added
- The V3 API is now available. The only difference from V2 is:
  - Serialized posts with omitted comments now have two comments after the
    omitted part (and this count is defined in server config). They also have a
    new _omitCommentsOffset_ field, that contains the offset of omitted part in
    the _comments_ array (which now has three comments if the omitted part is
    present). Client must use the _omitCommentsOffset_ field to determine, which
    of the _comments_ are before and after the omitted part.

    It is a broken change because the old clients expects the _comments_ array
    of a post with omitted comments to always have two comments total.
- New API endpoint `GET /v2/users/sparseMatches?qs=...` to get list of
  non-private users and groups, whose username _sparse matches_ the query
  string. The sparse match means that the username must contain all the query
  string letters in the given order, but with possible other letters in between.
  For example, the 'ur[an]us', '[an]tenna', 's[a]tur[n]' matches the "an" query.

  The query string should match the `[a-z0-9-]{2,}` regex.

  The order of the results is not specified, the client should sort them at
  their side.

## [2.20.0] - 2024-05-27
#### Changed
- Comments from users who have blocked the current viewer are visible to the
  viewer under his own posts.
- The viewer can "unlock" the comment using the "unlock-banned" URL parameter
  (`GET /v2/comments/:commentId?unlock-banned`). This parameter removes the
  HIDDEN_AUTHOR_BANNED hide type from comment and allows the comment to be
  viewed (if it is not HIDDEN_VIEWER_BANNED).

## [2.19.1] - 2024-04-26
#### Changed
- Repair the bans symmetry. Comments of users, who have blocked the current
  viewer, are not visible to him, and have a hideType of '4' (the
  `Comment.HIDDEN_VIEWER_BANNED` constant).

## [2.19.0] - 2024-04-19
#### Changed
- The bans are fully symmetrical now. If A bans B, then:
  - A doesn't see B's posts, comments content, likes and comment likes;
  - B doesn't see A's posts, comments content, likes and comment likes.
  
  By default, comments are displayed as placeholders, but the viewer can turn
  them off completely. Also, one can disable bans in some groups, see the
  [2.7.0] release for the bans logic in this case.
- /!\ The ban symmetry is DELIBERATELY BROKEN for now. It works for likes and
  comment likes, but the A's comments content is still visible for B. Such
  comments have an additional `_hideType = 4` field in API responses ('4' is the
  `Comment.HIDDEN_VIEWER_BANNED` constant). The client code can hide such
  comments on its level.
### Fixed
- A user's unread directs counter now takes into account the visibility of
  direct messages and comments on them.

## [2.18.5] - 2024-04-09
### Fixed
- Do not allow to resume the inactive account with a wrong password.

## [2.18.4] - 2024-02-26
### Fixed
- Provide full user data in the 'like:new' realtime event. Previously, the event
  only included a small subset of the data, making it impossible for the client
  to fill out the store correctly.
- Bug in comment visibility detection, that leads to incorrect behavior in the
  following case:
  1. User A turns off bans in some group G
  2. User A bans user B
  3. User A subscribes to the post P in group G
  4. User B adds a new comment to the post P
  
  In this case user A won't get a new comment notification, even though she can
  see the B's comment.

## [2.18.3] - 2024-02-23
#### Changed
- Site admin's email added to the frozen user's error message.

## [2.18.2] - 2024-02-18
### Fixed
- Use a full text parser for backlinks search in their short form
  (/username/shortId). It prevents false positives, when some URL in text
  contains a shortlink-looking fragment.
- Keep the 'invitation_id' field during the user's personal data deletion to
  preserve connection with the inviting user.

## [2.18.1] - 2024-01-26
### Fixed
- A realtime bug that caused data leakage via the 'post:update' and
  'post:destroy' events.
  
  The sample scenario was as follows:
  - UserA subscribed to UserB, UserB subscribed to UserC, UserC is private;
  - UserB likes post of UserC;
  - UserC updates that post. 
  
  In this case, the UserA could receive the 'post:update' event with the full
  content of updated post (which is normally not available to him).

## [2.18.0] - 2024-01-19
### Changed
- FreeFeed server now uses Socket.IO v4 for realtime messaging. The previous
  versions of Socket.IO _clients_ (v2 and v3) are also supported.

## [2.17.0] - 2023-12-21
### Added
- Users can now subscribe to all comments of posts commented by them. For this
  purpose one can set the `notifyOfCommentsOnCommentedPosts` flag to _true_ in
  their preferences.

### Changed
- The 'post:update' realtime event can now be fired to a comment author when
  comment is created or deleted. It happens when the action changes the user's
  subscription to comments state (the 'notifyOfAllComments' field of the
  serialized post).

## [2.16.1] - 2023-11-25
### Fixed
- Handle 'post_comment' event in notifications digest.

## [2.16.0] - 2023-11-24
### Added
- Users can now subscribe to all comments of particular posts or of all their
  own posts.
  - To subscribe/unsubscribe to the particular post (from any user), one can use
    new `POST /v2/posts/:postId/notifyOfAllComments` API method with body 
    `{ "enabled": true/false }`.
  - To subscribe to all user's own posts, they can set
    `notifyOfCommentsOnMyPosts` flag to _true_ in user's preferences.
  - The current status of the subscription can be checked with the new boolean
    `notifyOfAllComments` field of the serialized post.
  - The reply/mention events are always created and cannot be muted with this
    mechanism.
  - All comments to the direct message are creates notifications by default to
    all message recipients. This behavior is not changed, but now any of
    recipients can disable it using the API method described above.
  - There are three new event types with this feature:
    - 'post_comment' - a new comment was created in the regular post (direct
      messages produces a 'direct_comment' event);
    - 'post_comments_subscribe' - user subscribed to all comments of the post;
    - 'post_comments_unsubscribe' - user unsubscribed from all comments of the
      post.

### Fixed
- Previously, a single comment could trigger multiple events for the same user.
  For example, a comment on a direct message mentioning the direct recipient
  triggered two event events: 'direct_comment' and 'mention_in_comment'. This
  has now been fixed: a single comment always triggers only one event, and the
  reply/mention event takes precedence.

### Changed
- Dropped support for Node.JS < 18.

## [2.15.0] - 2023-10-11
### Changed
- When editing a post, access rights to existing destination feeds of the post
  are no longer checked. This change allows the author of the post to always be
  able to edit it if he has access. Here are some examples of situations
  affected by this change:
  - The author wrote a post in a public group and his own feed. The group became
    private, and the author lost access to it, but he still has access to his
    post. He should be able to edit his post.
  - The author sent a direct message, but the recipient deleted his account. The
    author can no longer send direct messages to him, but he should still be
    able to edit the existing direct message. This case is particularly
    important because the author of the direct message cannot delete recipients
    himself.

## [2.14.0] - 2023-09-02
### Added
- Short Links for posts and comments in FreeFeed texts: e.g. `/user/4a39b8`
  (a linked post) or `/groupname/f482e5#ad2b` (a linked comment).

  A short link consists of `/` followed by username/groupname, and another `/`
  followed by `post_short_id`. There's also an optional part in the end 
  consisting of `#` and `comment_short_id`. Short IDs are hexadecimal strings, 
  6 to 10 chars long (post_short_id), or 4 to 6 chars long (comment_short_id).

  FreeFeed clients will be expected to parse these in texts and make them 
  clickable hyperlinks where it makes sense. Server-side support includes:

  - Generating short IDs for posts and comments, storing them in the DB
  - Exposing new property `shortId` for post and comment objects in all
    relevant API responses
  - Allowing using post's short ID in the "get single post" API request
    (`GET /v2/posts/:postId`)
  - Necessary changes in Backlinks and Notifications to enable the short links
    support
  - An admin script for backfilling short IDs for existing FreeFeed instances

- A `withModifiedConfig` helper function that allows to override configuration
  in test.

- A new `/v2/posts/:postId/backlinks` API method that returns feed of all posts
  that reference the given post.

## [2.13.2] - 2023-08-03
### Fixed
- "Discarding" backlinks in comments when the link in their parent post is
  removed.

## [2.13.1] - 2023-07-18
### Fixed
- Using correct thumbnail URLs for WebP images when using imgproxy. Imgproxy's
  URLs should be based on original's URL, so we use original '.webp' file name
  here with '?format=jpg' modifier.

## [2.13.0] - 2023-07-15
### Added
- Translation post and comment texts (via Google Translate) to the user
  language.
  - Two API methods added:
    - `GET /v2/posts/:postId/translated-body`
    - `GET /v2/comments/:commentId/translated-body`

    Both methods returns the translated body text and detected source language
    in form: `{translatedText: string; detectedLang: string}`. Client can
    specify language to translate to with `lang` query parameter. If no language
    is specified, the preferred language from 'Accept-Language' header is used.

  - The server administrator can enable translation in the configuration file
    and set the Google API key. API usage is limited by configuration, the
    administrator can set server-wide limit of translated characters per month
    and per-user limit of translated characters per day.

## [2.12.4] - 2023-07-02
### Fixed
- Ban visibility rules were incorrectly handled by some comment related methods
  (get comment by id, get list of comment likes). For example, the viewer
  couldn't see the list of likes of a banned user's comment, even if the viewer
  selected to see banned users in the comment's post group.

## [2.12.3] - 2023-06-02
### Fixed
- Exif orientation is a complex beast. The "Orientation" tag can be presents in
  several EXIF sections: in IFD0 (the image itself) or in IFD1 (image
  thumbnail). Different libraries and even browsers can read thumbnail's
  Orientation as an image Orientation. So now we explicitly read
  'IFD0:Orientation' and 'IFD1:Orientation' from the image. We rotate it
  according to IFD0's and remove all orientation tags before saving the image.

## [2.12.2] - 2023-06-02
### Fixed
- After version 1.23.1 the 'gm' package stopped clearing image metadata after
  orientation correction. As a result, the picture was rotated, but the
  "Orientation" EXIF tag remained the same. This caused the image to display
  incorrectly in the browser. We now clear this tag if a rotation occurred.
- Statistics did not give the number of subscriptions and subscribers to the
  user himself, if that user is private.

## [2.12.1] - 2023-05-26
### Fixed
- Downgrade GraphicsMagick to fix image-rotation

## [2.12.0] - 2023-05-26
### Added
- The new API method `GET /v2/users/:username/statistics` returns actual,
  dynamically calculated user/group statistics. The returned values depend on
  the current viewer and only show the number of entities the current user has
  access to.
### Changed
- The old 'statistics' user field is still returned, but it is no longer
  updated. Clients should use the `GET /v2/users/:username/statistics` method.

## [2.11.0] - 2023-05-20
### Added
- Language-specific (Russian) Daily Active Users statistic is now calculated
  daily

## [2.10.0] - 2023-05-05
### Added
- Calendar view

### Fixes
- Rate limiter now correctly counts requests with different methods

## [2.9.0] - 2023-04-20
### Changed
- Simplified rate limiter config and made block duration configurable

### Fixed
- The 'acceptDirectsFrom' modes for old users, with default server properties,
  are correctly extracted now.
- Synchronized directs allowance logic between User model method and user
  serializer. Added new tests.

## [2.8.0] - 2023-02-15
### Added
- New Datadog counters for invitations:'invitation.create-time',
  'invitation.create-requests', and 'invitation.use-requests'.
- Allow moderator to disable/enable invitations for specific user. Methods are:
  - `POST /users/:username/disable-invites`
  - `POST /users/:username/enable-invites` 
- New method `POST /v2/comments/byIds` for batch retrieval of comments. The
  request body has form `{ "commentsId": [...] }`.

### Changed
- Invitations from inactive (i.e. in some 'gone' status) users stop working.
- The serialized view of COMMENT_MODERATED event now contains non-null
  'created_user_id' field when the event initiator is a post author. This event
  can be fired by group moderator or by the post author. In the first case we
  should hide the initiator, in the second case we should not.

### Fixed
- Invitations are no longer deleted when their author's data is deleted. These
  invitations are instead anonymized. This is important for keeping a connection
  with invited users.

## [2.7.0] - 2023-01-19
### Added
- New Admin API methods:
  - `GET /api/admin/users` method returns all users sorted by registration date.
  - `GET /api/admin/users/:username/info` method returns information about the
    specific user.
  - `POST /users/:username/suspend` and `POST /users/:username/unsuspend`
    methods suspended/unsuspended given user.
- The server administrator can disallow registration without invites. The
  ability to create new invites can be limited or disabled for the given user.
  One can see who invited the user (this is public information).
  - The _config.invitations_ section was added with two fields:
    _requiredForSignUp_ (boolean, false by default) and _canCreateIf_ (array of
    conditions, empty by default).
  - If _config.invitations.requiredForSignUp_ is true, then:
    - Registration without invites is not allowed;
    - Multi-use invites are not not allowed.
  - API changes:
    - `GET /v2/server-info` method returns new _registrationRequiresInvite_ and
      _multiUseInvitesEnabled_ boolean fields.
    - `GET /v2/users/:userName` method returns new _invitedBy_ field. The value
      is either _null_ or the name of the user who invited it.
    - New method `GET /v2/invitations/info` returns invitations creation
      parameters for the current user: _canCreateNew_ (boolean), _singleUseOnly_
      (boolean), _reasonNotCreate_ (null or object).
  - The server administrator can disable invites via the 'usermod' script for
    the given user.
- Users can now disable bans in certain groups. One can disable bans in any
  group, no need to be an admin or even a member of the group.

  If user disabled bans in some group then:
  - He can see posts, comments, likes and comment likes in this group from users
    he banned.
  - If he is the administrator of this group, he can see posts in this group
    from users who have banned him.

  There is a new file, _doc/visibility-rules.md_, with description of this
  algorithm.

  API changes:
  - New methods `POST /groups/:groupName/disableBans` and `POST
    /groups/:groupName/enableBans`;
  - 'youCan' field of serialized group can have value 'disable_bans' or
    'undisable_bans';
  - There are two new events in user notifications: 'bans_in_group_disabled' and
    'bans_in_group_enabled'.

### Changed
- The GONE_SUSPENDED user status now doesn't allow user to activate her account
  back.
- The `POST /api/admin/users/:username/freeze` methods now accepts 'freezeUntil'
  parameter in the following formats:
  - ISO Datetime
  - ISO Date
  - ISO Duration ("P...")
  - The "Infinity" string (means forever freeze)
- The admin user serializer now returns 'freezeUntil' and 'goneStatus' fields.

## [2.6.0] - 2023-01-18
### Added
- Server now can handle multiple API versions simultaneously as described in
  [RFC](https://paper.dropbox.com/doc/FreeFeed-API-SblfMOTWnFJcpSjvHs9h5). The
  current version is '2'. Added new file [API_VERSIONS.md](API_VERSIONS.md) with
  version history and brief description of FreeFeed versioning principles for
  API users.
  - Internally, the requested API version is available via the
    `ctx.state.apiVersion` property in REST controllers and via the
    `socket.apiVersion` property in the realtime handler.
  - Added new realtime command, 'status'. It returns the current properties of
    socket connection, which includes *userId*, *apiVersion* and *rooms* fields.
- Rate Limiter for API. It allows to specify number of anonymous and
  authenticated requests, which IP is allowed to make during configurable
  time-frame.
- Total number of requests is tracked via statsd.
- Administrative API. This API (with `/api/admin` prefix) is not a part of
  official and supported/versioned server API.

  Some users can have administrative roles:
  *administrator* and/or *moderator*. The *administrator* role can be assigned
  only by site operator with manual access to database. *Administrators* can
  appoint *moderators*. *Moderators* can perform some site management actions,
  for now it is the freeze-related actions.

  The following methods have been added:
  - Allowed for any administrative user:
    - `GET /api/admin/whoami` — info about user himself, in particular, the
      roles he has.
    - `GET /api/admin/journal` — journal of all administrative actions.
  - Allowed for *administrators* only:
    - `GET /api/admin/members` — list of all administrative users.
    - `POST /api/admin/members/:username/promote` — gives user a *moderator*
      role.
    - `POST /api/admin/members/:username/demote` — removes *moderator* role from
      user.
  - Allowed for *moderators* only:
    - `GET /api/admin/users/frozen` — list of users who are currently frozen.
    - `POST /api/admin/users/:username/freeze` — freeze user until a certain
      time.
    - `POST /api/admin/users/:username/unfreeze` — unfreeze user.

## [2.5.2] - 2023-01-04
### Fixed
- Fixed argument-parsing of cli-tools to be compatible with commander-9.x
  (regression in 2.5)

## [2.5.1] - 2022-12-27
### Fixed
- Downgrade graphicsmagick dependency to 1.23.1. Otherwise auto-orientation of
  uploaded images got broken. (regression in freefeed 2.5.0)

## [2.5.0] - 2022-12-25
### Added
- Email verification mode. With the 'emailVerification.enabled' configuration
  flag, the server starts to request and check the existence of email addresses
  during registration and email change. Also, the address normalization is
  enabled, that is, you can not register an account with address
  user+tag@example.com if there is already an account with address
  user@example.com.
  - New API method `POST /v2/users/verifyEmail` sends verification code to the
    given email.
  - Site administrator should run `yarn babel bin/normalize_emails.js` command
    to normalize existing addresses in database.
- User accounts can now be suspended (frozen) for a certain amount of time.
  Suspended accounts cannot log in and call API methods.

  This feature is only available at the User model level and is not yet
  reflected in the API. But the site administrator can freeze/unfreeze users via
  the 'usermod' script.

### Changed
- BestOf, Everything and Search pages are not available from anonymous access

### Fixed
- ExifTools write errors don't interrupts the attachment creation anymore.

## [2.4.1] - 2022-11-23
### Fixed
- Incorrect 'file-type' import

## [2.4.0] - 2022-11-23
### Added
- Serialized users and groups now have two new fields: _youCan_ and _theyDid_.
  These fields are arrays of strings and represents actions, that the current
  user can perform over the object (_youCan_) and actions, that the object
  performed over the current user (_theyDid_). The incomplete list of actions
  is: "post", "dm", "(un)subscribe", "(un)ban", "block",
  "(un)request_subscription" and so on.
- Users can now write posts to public and protected groups that they are not members of.
- Group administrators can now block certain users from write to the group. This
  feature includes:
  - New API methods for group administrators:
    - `GET /v2/groups/:groupName/blockedUsers` 
    - `POST /v2/groups/:groupName/block/:userName`
    - `POST /v2/groups/:groupName/unblock/:userName`
  - New event types, 'blocked_in_group' and 'unblocked_in_group', which are sent
    to the (un)blocked user and to the all of group admins.
  - When some user is blocked/unblocked in a group, the 'global:user:update'
    realtime event _about the group_ is sent. This event contain general group
    info, including the new _youCan_ (with "post") and _theyDid_ (with "block")
    fields, so the listening user can determine, if he can or cannot post to the
    group, and why.

## Changed
- Notifications: hide the initiator of some events from the event target user.
  It is useful, for example, to protect the anonymity of group admins. The
  affected event types are: 'comment_moderated', 'post_moderated',
  'blocked_in_group', 'unblocked_in_group'.

### Fixed
- User data deletion process has been optimized for likes and comment likes.
- Job manager now starting with a random delay for more even distribution of the
  job fetching in multi-node environment.
- In the notifications digest email, links to the backlinked entities was
  relative instead of absolute.

## [2.3.1] - 2022-07-21
### Fixed
- Remove orphan post/comment likes during user deletion
- 
## [2.3.0] - 2022-07-20
### Added
- Loggly (https://www.loggly.com/) logging service support

### Fixed
- Call of 'usermod' CLI command in package.json

## [2.2.0] - 2022-06-29
### Added
- Record auth type as monitoring metric tag

## [2.1.0] - 2022-06-01
### Removed
- Support for NodeJs 12.x
- Support for Postgres 10.x, 11.x

### Changed
- Using ESBuild instead of Babel for transpiling
- The user preference defaults are now defined in configuration.
- The notification digest's mail subject is now defined in configuration.

### Added
- The ability to override user preference defaults based on user's creation
  time. It allows changing the default values for new users if needed.
- 'direct_left' notification in the notification digest.

### Fixed
- Invalid texts for backlink-related notifications in the notification digest.
- Users will not longer receive notifications about someone else's actions over
  inaccessible (for recipient) posts. Previously, such notifications were sent
  when a user's comment was deleted in a post that was hidden from him.
- Multiple 'backlink_in_post' and 'backlink_in_comment' notifications when the
  author of a post/comment edits its text.

## [1.109.0] - 2022-05-12
### Fixed
- Ignore minor exif-errors while sanitizing images.
- Skip files which can not be sanitized because if errors after and report the errors.
- In the case of registration with an already taken email, return 'This email
  address is already in use' message instead of obscure 'Invalid email'.

## [1.108.1] - 2022-05-03
### Changed
- Temporary turned off the batch attachments sanitize job handler 

## [1.108.0] - 2022-04-20

Technical release. Updated dependencies

## [1.107.0] - 2022-03-24
### Added
- New method _sanitizeOriginal_ of Attachment object allows to sanitize metadata
  of existing attachments.
- New API methods:
  * `GET /v2/attachments/my/stats` (in `read-my-files` scope) returns statistics
    about attachments of current user. The output includes total number of
    attachments, number of sanitized attachments, and the state of the sanitize
    task (if present).
  * `POST /v2/attachments/my/sanitize` (in `manage-my-files` scope) initiates
    the sanitization of existing user's attachments.

## [1.106.0] - 2022-02-03
### Added
- The new server-side user preference flag _sanitizeMediaMetadata_ (default:
  true). When this flag is true, uploaded files are checked for sensitive
  metadata tags related to GPS, owner info and serial numbers. All such tags are
  removed from the file. This applies not only to images, but also to all other
  files such as videos.
- New attachment (and its database table) field _sanitized_ indicates that the
  file metadata was sanitized. The value of field is 0 (wasn't sanitized) or 1
  (was sanitized).

## Changed
- Reduced the password reset token length to 12 bytes. Perhaps enormous tokens
  (48 bytes = 96 hexadecimal characters) were broken in the email texts. Also
  reduced the TTL of the token from several years :) to 8 hours.

## [1.105.0] - 2022-01-05
### Fixed
- A group administrator could not delete a message with an empty body (and with
  attachments) from a managed group.
- "Direct left" events could be duplicated. They are unique now

### Added
- The new API method, `GET /v2/attachments/my` returns all attachments created
  by the current user, paginated and in the reverse date order. 
  
  This method accepts two URL parameters: _limit_ (default: 30, maximum: 100)
  and _page_ (1-based, default: 1). The result format is { attachments:
  AttObject[], users: UserObject[], hasMore: boolean }.
- The new API token scope: `read-my-files`. For now it contains only one method:
  `GET /v2/attachments/my`

### Changed
- The serialized attachments now have an additional field _postId_. This field
  is either _null_ or the UUID of the post to which the file is attached.

## [1.104.2] - 2021-12-13
### Fixed
- Allow to edit direct message without recipients.

## [1.104.1] - 2021-12-08
### Fixed
- backlink indexer script: add support for orphaned comments

## [1.104.0] - 2021-12-08
### Added
- Any recipient of a direct message (except the author of the message) can now
  leave the direct, i.e. exclude themselves from direct recipients. Any
  recipient's comments and likes of the post will not be removed.

### Changed
- The backlinks logic was rewritten to use a separate table for backlinks
  information. You must run `yarn babel bin/reindex_backlinks.js` to fill the
  `backlinks` table by the existing links.

## [1.103.1] - 2021-11-18
### Changed
- Disabled backlinks (performance issues. still)

## [1.103.0] - 2021-11-17
### Changed
- Re-enabled backlinks (see description in 1.101.0)

## [1.102.0] - 2021-10-12
### Changed
- Use original filename in content-disposition header.
  Now, it's for both name and extension. Before, it only used original extension for whitelisted formats, setting empty extension for others.

## [1.101.1] - 2021-09-19
### Changed
- Disabled backlinks (performance issues)

## [1.101.0] - 2021-09-19
### Added
- All serialized posts now have a new numeric 'backlinksCount' field. This field
  is the count of texts (posts or comments) that mentioned the post's UUID and
  visible to the current user. The client should display this count as a link to
  the search by post's UUID.

  When the post hase new or removed mention in somewhere, the 'post:update'
  realtime message is delivered with the updated backlinksCount.

  It is also recommended to re-run the search indexer (`yarn babel
  bin/reindex_search.js`) after this changes applied. The indexing of UUIDs in
  the plain texts (not in URLs) is slightly changed, so in rare cases the search
  may work incorrectly. These changes are not affects the backlinks
  functionality though.
- There are two new notification types related to backlinks: 'backlink_in_post'
  (fired when your post or comment has been mention in somebody's post) and
  'backlink_in_comment' (same for mention in comment).
  
  The notification objects in  API have two new fields: 'target_post_id' and
  'target_comment_id'. The 'target_post_id' is an ID of the mentioned post and
  the 'target_comment_id' is an ID of the mentioned comment. When the
  'target_comment_id' is not null, the 'target_post_id' is an ID of post this
  comment belongs.

### Changed
- Post can now have an empty body if it contains one or more attachments.

## [1.100.0] - 2021-07-30
### Added
- The `DELETE /v1/posts/:postId` API method now can have one or more 'fromFeed'
   GET-parameters. These parameter defines the 'Posts' feeds (by username) from
   which this post should be deleted. If there are no 'fromFeed' parameters, the
   post will be deleted completely (by author) or from all managed groups (by
   groups admin).

### Changed
- When the private group info is changed, the 'global:user:update' realtime
  event is delivered only to the group subscribers (earlier it was sent to
  everyone).

## [1.99.1] - 2021-07-03
### Fixed
- GDPR script works again

## [1.99.0] - 2021-06-08
### Fixed
- The gone user's comment likes was counted in some API responses and realtime
  messages.

### Removed
- The old session tokens (SessionTokenV0) are no longer supported.

## [1.98.0] - 2021-04-08

**WARNING:** this version requires you to run manual migration script. It might run
for tens of minutes (depending on the size of database and your server's hardware
specs).

`yarn babel bin/migration_comment_numbers.js`

### Added
- New API method `GET /v2/notifications/:notifId` allows to fetch single
  notification by its id.
- The new `yarn babel` helper script in the package.json. This command is a
  shortcut for the `babel-node --extensions ".js,.jsx,.ts"` (all extensions used
  in this project), so one can now run CLI scripts as `yarn babel
  bin/somescript.js`
- The comment numbers in API output. Each comment now has the `seqNumber` field
  which is a sequence number of the comment in the post. Some rules on numbering:
    - The first comment has number 1.
    - Every new comment gets a number of `max(seqNumber) + 1`.
    - When a comment is deleted, the numbers of other comments are not changed. It
      allows to detect the comments deletion by holes in the numeration.
    - When the last comment is deleted, the `max(seqNumber)` is decreased, because
      the last comment always has the maximum number. So next added comment will
      have the same number as the deleted.
- The new API methods:
    - `GET /v1/comments/:commentId` returns comment by its ID;
    - `GET /v2/posts/:postId/comments/:seqNumber` returns comment by its
      `seqNumber` in the given post;
    - `POST /v2/posts/byIds` returns posts by their IDs. It uses the POST method
      because it can accept many post IDs (up to 100 at once). The POST body
      format is `{ "postIds": [...] }`. The output schema is the same as in other
      post-collections methods (like `GET /v2/everything`), but it has an
      additional `postsNotFound` field with those post IDs that were not found.
      This method accepts `maxComments=all` and `maxLikes=all` get parameters.
- WebP attachments support. The uploaded WebP originals are kept unchanged, but
  have JPEG thumbnails for better compatibility with older browsers.
- The "to:" search operator. "to:user1,group2" limits search to posts published
  in group2 feed or written _to_ user1 as a direct message. This operator acts
  like "in:" for the groups but also allows to search in direct messages with
  the specific addressee.

## [1.94.2] - 2021-03-09
### Fixed
- Handle deleted posts/comments/users in the notification emails

## [1.94.1] - 2021-02-24
### Fixed
- The 'create attachment'  method now accepts any name for the file in form
  field. It should fix upload issues with some third-party clients.

### Added
- Expose some server settings via /v2/server-info for the client needs. The new fields are:
  - attachments { fileSizeLimit, maxCountPerPost } 
  - maxTextLength { post, comment, description }.

## [1.94.0] - 2021-02-18
### Fixed
- Fixed attachment creation bug that caused backend crash on image upload and
  empty `users` field of the `POST /v1/attachments` response.

### Changed
- Raise max post and comment lengths to 3000 chars

## [1.93.0] - 2021-01-27
### Added
- The notification events are now delivered to the 'user:{userId}' realtime
  channel with the 'event:new' message type. The message format is the same as
  in `GET /v2/notifications` response.

### Changed
- Do not block authorization sessions if token with the invalid issue is comes.
  We probably should add another blocking criteria in the future.
- Remove old authorization sessions by last use (instead of last update) time.

## [1.92.1] - 2021-01-24
### Added
- Count blocked auth sessions in StatsD

## [1.92.0] - 2021-01-24
### Changed
- Eslint is applied to all source tree now. The specific exceptions is defined
  in .eslintignore file.

## [1.91.0] - 2021-01-15
### Fixed
- Properly index texts with HTML-like tags (like spoiler tags)

### Added
- The new type of authorization sessions (SessionTokenV1). Sessions can be
  created, reissued, closed (at sign out); user can view list of their session
  with the information of last usage and close one or more of them. The old
  session tokens (SessionTokenV0) are still supported but deprecated.
- The 'proxyIpHeader' config option (default value is 'X-Forwarded-For') for the
  instances behind the proxy. Active when the 'trustProxyHeaders' option is
  true.
- Explicit list of the attachments' MIME types that should be served with
  'Content-Disposition: inline'. All other attachments should be served with
  'Content-Disposition: attachment' to prevent in-browser execution of active
  content.
## [1.90.1] - 2021-01-12
### Fixed
- Prevent the theft of attachments from other posts when creating a post.

## [1.90.0] - 2020-12-29
### Fixed
- The 'post:new' realtime event was emitted without the `realtimeChannels`
  field. As a result, the client had no information on which channels the
  message was sent to. This led to new posts appearing in unrelated feeds.

## [1.89.1] - 2020-12-15
### Fixed
- Fix EJS-templates, which broke cron-scripts

## [1.89.0] - 2020-12-13
### Added
- Initial Typescript definitions for DbAdapter and models

### Removed
- Old serializers (they were not used already)

## [1.88.1] - 2020-11-17
### Fixed
- Isolate data-changes to specific realtime-users. Previously, comments which
  were marked as hidden for one of the users could be delivered as hidden to
  other users too.

## [1.88.0] - 2020-11-10
### Fixed
 - Send 'comment:new' realtime event for comments from banned users (to display
   them as placeholders, if viewer chooses to see them)

### Added
 - Application tokens now have an `expiresAt` field. The expiration time can be
   specified during token creation. Tokens are automatically invalidated after
   the expiration time.

 - We added new `activationCode` field to responses, which create or reissue app
   tokens. This code can be used to obtain full token value. Activation codes
   are short (6 alphanumeric characters) and have narrow lifetime (5 min), they
   are useful for transfer via the non-secure communication channel.

 - The output of `GET /v2/server-info` has a new field
   _externalAuthProvidersInfo_ that contains an id, brand and title of each
   available external identity provider, so the client can show the proper
   buttons even if it doesn't know about these providers. The type of this field
   is `{ id: string, brand: string, title: string }[]`. The
   _externalAuthProviders_ field still present for compatibility with the old
   clients and contains only id's of these providers.

### Changed
 - The realtime socket authorizations is now re-validates every 5 minutes to
   handle the expired app tokens.
 
 - The format of _externalAuthProviders_ configuration key was changed, see the
   [separate document](config/external-auth-providers.md) for the details. The
   site administrator can now configure almost any OAuth2 external identity
   provider. There are three predefined templates for Google, Facebook, and
   GitHub.

 - The new fields in the config: _siteTitle_, _company.title_ and
   _company.address_. These fields can be used to customize site (FreeFeed
   instance) branding in emails, RSS feeds and service messages.

## [1.87.0] - 2020-10-13
### Added
 - The Server-Timing response header (for now, it contains a single metric,
   'total' - the total request processing time)

### Fixed
 - In the real-time message about the groups' update, the listener's
   subscription to the groups additionally checked. Without this check, the user
   could see groups he isn't subscribed to in the recent groups' list.

## [1.86.0] - 2020-09-15

### Added
- Improve search: search by exact word form, by prefix and with word order
  operator

## [1.85.0] - 2020-09-01

### Fixed

- Groups in realtime events (such as `user:update` or `global:user:update`) now
  serializes according to the current user. This affects the visibility of the
  group's administrators list.
- Respect privacy-settings given during account creation

### Changed
- The main homefeed hide list is now applied to posts authored by friends (in
  _friends-all-activity_ mode). It affects the following situation: you are
  subscribed to the user U in main homefeed and to the group G in secondary
  homefeed, and U created a post in G. Now you will not see this post in main
  homefeed in _friends-all-activity_ mode.
