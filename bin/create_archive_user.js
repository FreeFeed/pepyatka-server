#!node_modules/.bin/babel-node

import request from 'superagent'
import bluebird from 'bluebird'

global.Promise = bluebird;
global.Promise.onPossiblyUnhandledRejection((e) => { throw e; });


const host = 'https://freefeed.net';

const args = process.argv.slice(2);

if (args.length !== 4) {
  process.stdout.write(`Usage: create_archive_user.js <freefeed_username> <friendfeed_username> <public or private> <password>\n`);
  process.exit(1);
}

const freefeed_username = args[0];
const friendfeed_username = args[1];
const password = args[3];
let is_private;

if (args[2] === 'public') {
  is_private = 0;
} else if (args[2] === 'private') {
  is_private = 1;
} else {
  process.stdout.write(`Unexpected ${args[2]}, expected 'public' or 'private'\n`);
  process.exit(1);
}

async function main() {
  const email =  `freefeed.net+${freefeed_username}@gmail.com`;
  let auth_token = ``;
  let user_id = ``;


  process.stdout.write(`Creating a placeholder account @${freefeed_username} for @${friendfeed_username} comments from FriendFeed\n`);
  process.stdout.write(`Host: ${host}\n\n`);

  // Create user
  await request
    .post(`${host}/v1/users/sudo`)
    .send({ username: freefeed_username, password, email })
    .then((res) => {
      auth_token = res.body.authToken;
      user_id = res.body.users.id;
      process.stdout.write(`User @${freefeed_username} created: ${user_id}\n\n`);
    }, (err) => {
      process.stdout.write(`Failed to create user: @${freefeed_username}\n`);
      process.stdout.write(`Status: ${err.response.status}\n`);
      process.stdout.write(`Text: ${err.response.text}\n`);
      process.exit(1);
    });

  // Update description
  const description = `This is a placeholder account for @${friendfeed_username} comments from FriendFeed.com archives. Archives FAQ: https://dev.freefeed.net/w/archives-faq/`;
  await request
    .put(`${host}/v1/users/${user_id}`)
    .set(`X-Authentication-Token`, auth_token)
    .send({ user: { isPrivate: is_private, isProtected: is_private, description } })
    .then(() => {
      process.stdout.write(`Description changed to:\n---\n${description}\n---\n\n`);
    }, (err) => {
      process.stdout.write(`Failed to update description for user: @${freefeed_username}\n`);
      process.stdout.write(`Status: ${err.response.status}\n`);
      process.stdout.write(`Text: ${err.response.text}\n`);
      process.exit(1);
    });

  // Update privacy
  if (is_private) {
    await request
      .put(`${host}/v1/users/${user_id}`)
      .set(`X-Authentication-Token`, auth_token)
      .send({ user: { isPrivate: `1`, isProtected: `1` } })
      .then(() => {
        process.stdout.write(`User feed is private\n`);
      }, (err) => {
        process.stdout.write(`Failed to update privacy settings for user: @${freefeed_username}\n`);
        process.stdout.write(`Status: ${err.response.status}\n`);
        process.stdout.write(`Text: ${err.response.text}\n`);
        process.exit(1);
      });
  } else {
    process.stdout.write(`User feed is public\n`);
  }

  // Update profile pic
  await request
    .post(`${host}/v1/users/updateProfilePicture`)
    .set(`X-Authentication-Token`, auth_token)
    .attach(`image`, `bin/friendfeed.png`)
    .then(() => {
      process.stdout.write(`Profile picture updated\n`);
    }, (err) => {
      process.stdout.write(`Failed to update profile picture user: @${freefeed_username}\n`);
      process.stdout.write(`Status: ${err.response.status}\n`);
      process.stdout.write(`Text: ${err.response.text}\n`);
      process.exit(1);
    });

  process.stdout.write(`\nArchive user @${freefeed_username} has been created successfully!\n`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write(e.message);
    process.exit(1);
  });
