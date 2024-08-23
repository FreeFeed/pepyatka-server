import { User } from '../../../app/models';

export async function createUser(username: string): Promise<User> {
  const user = new User({ username, password: 'pw' });
  await user.create();
  return user;
}

export function createUsers(usernames: string[]): Promise<User[]> {
  return Promise.all(usernames.map((username) => createUser(username)));
}

export function createNUsers(count: number): Promise<User[]> {
  const usernames = Array.from({ length: count }, (_, i) => `user${i}`);
  return createUsers(usernames);
}
