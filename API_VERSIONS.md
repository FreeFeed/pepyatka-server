# API Versions

All backward-incompatible FreeFeed API changes will be documented in this file.

See the [About API versions](#about-api-versions) section in the end of this
file for the general versioning information.

## [4] - 2025-02-01
### Changed
- The attachment serialization is changed. The new format contains the following
  fields:
  - _id_ (string) - the UUID of the attachment
  - _mediaType_ (string) - the media type of the attachment, one of 'image',
    'video', 'audio', 'general'
  - _fileName_ (string) - the original filename of the attachment
  - _fileSize_ (number) - the size of the attachment's original file in bytes
  - _previewTypes_ (array of string) - the array of available preview types of
    the attachment, can be empty or contains the following values: 'image',
    'video', 'audio'
  - _meta_ (object) - optional field with temporary or not essential media
    metadata (all fields are optional):
    - _dc:title_: the audio/video title
    - _dc:creator_: the audio/video author name
    - _animatedImage_: true if the video was created from an animated image
    - _silent_: true if the video has no audio track
    - _inProgress_: true if the media file is currently being processed
  - _width_ and _height_ (number) - the size of the original image/video file in
    pixels, presents only for 'image' and 'video' attachments, and when the
    processing is done
  - _duration_ (number) - the duration of the audio/video file in seconds,
    present only for 'audio' and 'video' attachments, and when the processing is
    done
  - _previewWidth_ and _previewHeight_ (number) - the size of the maximum
    available image/video preview in pixels, presents only when different from
    the _width_ and _height_
  - _postId_ (string|null) - the UUID of the post to which the attachment is
    attached
  - _createdBy_ (string) - the UUID of the user who uploaded the attachment
  - _createdAt_ (string) - the ISO 8601 datetime when the attachment was created
  - _updatedAt_ (string) - the ISO 8601 datetime when the attachment was updated

## [3] - 2024-06-21

### Changed
- Serialized posts now contains the _omittedCommentsOffset_ field. If post
  contains some omitted comments, this field contains the offset of omitted part
  in the _comments_ array. Client must use the _omitCommentsOffset_ field to
  determine, which of the _comments_ are before and after the omitted part.

  It is a broken change because in V2 API responses, when some comments are
  omitted, the _comments_ array always has two items. The V2 clients treats the
  _comments_ array as [beforeOmitted, afterOmitted].

  In the V3 API response, the _comments_ array can have more than two items, and
  the _omittedCommentsOffset_ can have values other than '1'.

## [2] - 2022-11-01

This is the initial API version (it is "2" instead of "1" for historical
reasons).

---

## About API versions

### General rules

FreeFeed API versions are a monotonically increasing sequence of integers. Any
backward incompatible API changes causes an increase in the version.

FreeFeed may support not only the latest version of the API, but several
previous versions as well. However, very old versions may be declared obsolete
and unsupported.

At each point in time, two versions of the API are specified: the current,
latest, version (*Vcurr*) and the minimum supported version (*Vmin*). Any
version in this inclusive range is supported by the server.

### Specifying a version in the request

Each REST API request has a path prefix with the version number. For example,
`GET /v2/server-info` is a request to the method `/server-info` of API version
2.

The real-time (socket.io) endpoint has a fixed path. The client must pass the
version number in the URL request parameter named `apiVersion`.

### Unsupported versions

If the client specified a version less than *Vmin* in the request, the server
will process the request as if the version was equal to *Vmin*.

If the client specified a version greater than *Vcurr* in the request, the
server will return a *404 Not Found* response.

It is different for realtime endpoint. Any version outside the [*Vmin* -
*Vcurr*] range is considered as the *Vmin* version.