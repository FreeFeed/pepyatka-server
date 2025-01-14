export const eventNames = {
  USER_UPDATE: 'user:update',
  POST_CREATED: 'post:new',
  POST_UPDATED: 'post:update',
  POST_DESTROYED: 'post:destroy',
  POST_HIDDEN: 'post:hide',
  POST_UNHIDDEN: 'post:unhide',
  POST_SAVED: 'post:save',
  POST_UNSAVED: 'post:unsave',
  COMMENT_CREATED: 'comment:new',
  COMMENT_UPDATED: 'comment:update',
  COMMENT_DESTROYED: 'comment:destroy',
  LIKE_ADDED: 'like:new',
  LIKE_REMOVED: 'like:remove',
  COMMENT_LIKE_ADDED: 'comment_like:new',
  COMMENT_LIKE_REMOVED: 'comment_like:remove',
  GLOBAL_USER_UPDATED: 'global:user:update',
  GROUP_TIMES_UPDATED: ':GROUP_TIMES_UPDATED',
  EVENT_CREATED: 'event:new',
  ATTACHMENT_UPDATE: 'attachment:update',
} as const;

export type EventName = (typeof eventNames)[keyof typeof eventNames];

interface IPublisher {
  publish(eventName: string, payload: string): Promise<any>;
}

export class PubSubAdapter {
  constructor(private publisher: IPublisher) {}

  ///////////////////////////////////////////////////

  userUpdated(payload: string) {
    return this.publish(eventNames.USER_UPDATE, payload);
  }

  ///////////////////////////////////////////////////

  postCreated(payload: string) {
    return this.publish(eventNames.POST_CREATED, payload);
  }

  postUpdated(payload: string) {
    return this.publish(eventNames.POST_UPDATED, payload);
  }

  postDestroyed(payload: string) {
    return this.publish(eventNames.POST_DESTROYED, payload);
  }

  postHidden(payload: string) {
    return this.publish(eventNames.POST_HIDDEN, payload);
  }

  postUnhidden(payload: string) {
    return this.publish(eventNames.POST_UNHIDDEN, payload);
  }

  postSaved(payload: string) {
    return this.publish(eventNames.POST_SAVED, payload);
  }

  postUnsaved(payload: string) {
    return this.publish(eventNames.POST_UNSAVED, payload);
  }

  ///////////////////////////////////////////////////

  commentCreated(payload: string) {
    return this.publish(eventNames.COMMENT_CREATED, payload);
  }

  commentUpdated(payload: string) {
    return this.publish(eventNames.COMMENT_UPDATED, payload);
  }

  commentDestroyed(payload: string) {
    return this.publish(eventNames.COMMENT_DESTROYED, payload);
  }

  ///////////////////////////////////////////////////

  likeAdded(payload: string) {
    return this.publish(eventNames.LIKE_ADDED, payload);
  }

  likeRemoved(payload: string) {
    return this.publish(eventNames.LIKE_REMOVED, payload);
  }

  ///////////////////////////////////////////////////

  commentLikeAdded(payload: string) {
    return this.publish(eventNames.COMMENT_LIKE_ADDED, payload);
  }

  commentLikeRemoved(payload: string) {
    return this.publish(eventNames.COMMENT_LIKE_REMOVED, payload);
  }

  ///////////////////////////////////////////////////

  globalUserUpdated(payload: string) {
    return this.publish(eventNames.GLOBAL_USER_UPDATED, payload);
  }

  groupTimesUpdated(payload: string) {
    return this.publish(eventNames.GROUP_TIMES_UPDATED, payload);
  }

  ///////////////////////////////////////////////////

  eventCreated(payload: string) {
    return this.publish(eventNames.EVENT_CREATED, payload);
  }

  ///////////////////////////////////////////////////

  attachmentUpdated(payload: string) {
    return this.publish(eventNames.ATTACHMENT_UPDATE, payload);
  }

  ///////////////////////////////////////////////////

  private async publish(channel: EventName, payload: string) {
    await this.publisher.publish(channel, payload);
  }
}
