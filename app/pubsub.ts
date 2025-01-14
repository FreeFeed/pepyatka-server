import { Comment, dbAdapter, Post } from './models';
import { serializeTimeline } from './serializers/v2/timeline';
import { List } from './support/open-lists';
import { PubSubAdapter } from './support/PubSubAdapter';
import { Nullable, UUID } from './support/types';

export class DummyPublisher extends PubSubAdapter {
  constructor() {
    super({
      publish: () => Promise.resolve(),
    });
  }
}

type UpdatePostOptions = {
  rooms?: Nullable<string[]>;
  usersBeforeIds?: Nullable<UUID[]>;
  onlyForUsers?: List<UUID>;
};

export default class pubSub {
  constructor(private publisher: PubSubAdapter) {}

  setPublisher(publisher: PubSubAdapter) {
    this.publisher = publisher;
  }

  async updateUnreadDirects(userId: UUID) {
    const unreadDirectsNumber = await dbAdapter.getUnreadDirectsNumber(userId);
    const user = { id: userId, unreadDirectsNumber: unreadDirectsNumber.toString() };
    const payload = JSON.stringify({ user });
    await this.publisher.userUpdated(payload);
  }

  async updateUnreadNotifications(userIntId: number) {
    const [{ uid: userId }] = await dbAdapter.getUsersIdsByIntIds([userIntId]);
    const unreadNotificationsNumber = await dbAdapter.getUnreadEventsNumber(userId);
    const user = { id: userId, unreadNotificationsNumber };
    const payload = JSON.stringify({ user });
    await this.publisher.userUpdated(payload);
  }

  async updateHomeFeeds(userId: UUID) {
    const feedObjects = await dbAdapter.getAllUserNamedFeed(userId, 'RiverOfNews');
    const payload = JSON.stringify({
      homeFeeds: feedObjects.map((f) => serializeTimeline(f)),
      user: { id: userId },
    });
    await this.publisher.userUpdated(payload);
  }

  async newPost(postId: UUID) {
    const payload = JSON.stringify({ postId });
    await this.publisher.postCreated(payload);
  }

  async destroyPost(postId: UUID, rooms: string[], onlyForUsers: List<UUID>) {
    const payload = JSON.stringify({ postId, rooms, onlyForUsers });
    await this.publisher.postDestroyed(payload);
  }

  async updatePost(
    postId: UUID,
    {
      rooms = null,
      usersBeforeIds = null,
      onlyForUsers = List.everything(),
    }: UpdatePostOptions = {},
  ) {
    const payload = JSON.stringify({ postId, rooms, usersBeforeIds, onlyForUsers });
    await this.publisher.postUpdated(payload);
  }

  async newComment(comment: Comment) {
    const payload = JSON.stringify({ commentId: comment.id });
    await this.publisher.commentCreated(payload);
  }

  async destroyComment(commentId: UUID, postId: UUID, rooms: string) {
    const payload = JSON.stringify({ postId, commentId, rooms });
    await this.publisher.commentDestroyed(payload);
  }

  async updateComment(commentId: UUID) {
    const payload = JSON.stringify({ commentId });
    await this.publisher.commentUpdated(payload);
  }

  async newLike(post: Post, userId: UUID) {
    const payload = JSON.stringify({ userId, postId: post.id });
    await this.publisher.likeAdded(payload);
  }

  async removeLike(postId: UUID, userId: UUID, rooms: string[]) {
    const payload = JSON.stringify({ userId, postId, rooms });
    await this.publisher.likeRemoved(payload);
  }

  async hidePost(userId: UUID, postId: UUID) {
    await this.publisher.postHidden(JSON.stringify({ userId, postId }));
  }

  async unhidePost(userId: UUID, postId: UUID) {
    await this.publisher.postUnhidden(JSON.stringify({ userId, postId }));
  }

  async savePost(userId: UUID, postId: UUID) {
    await this.publisher.postSaved(JSON.stringify({ userId, postId }));
  }

  async unsavePost(userId: UUID, postId: UUID) {
    await this.publisher.postUnsaved(JSON.stringify({ userId, postId }));
  }

  async newCommentLike(commentId: UUID, postId: UUID, likerUUID: UUID) {
    const payload = JSON.stringify({ commentId, postId, likerUUID });
    await this.publisher.commentLikeAdded(payload);
  }

  async removeCommentLike(commentId: UUID, postId: UUID, unlikerUUID: UUID) {
    const payload = JSON.stringify({ commentId, postId, unlikerUUID });
    await this.publisher.commentLikeRemoved(payload);
  }

  async globalUserUpdate(userId: UUID) {
    await this.publisher.globalUserUpdated(JSON.stringify(userId));
  }

  async updateGroupTimes(groupIds: UUID[]) {
    await this.publisher.groupTimesUpdated(JSON.stringify({ groupIds }));
  }

  async newEvent(eventId: UUID) {
    await this.publisher.eventCreated(JSON.stringify(eventId));
  }

  async attachmentUpdated(attachmentId: UUID) {
    await this.publisher.attachmentUpdated(JSON.stringify(attachmentId));
  }
}
