import { Strategy as LocalStrategy } from 'passport-local';

import { dbAdapter } from '../../models';
import { currentConfig } from '../../support/app-async-context';

export function init(passport) {
  passport.use(
    new LocalStrategy(
      {
        usernameField: 'username',
        passwordField: 'password',
      },
      async (username, clearPassword, done) => {
        try {
          let user;

          if (username.indexOf('@') === -1) {
            user = await dbAdapter.getUserByUsername(username.trim());
          } else {
            user = await dbAdapter.getUserByEmail(username.trim());
          }

          if (user && (await user.isFrozen())) {
            const { adminEmail } = currentConfig();
            done({
              message:
                'Your account has been suspended due to suspicious activity. ' +
                `Please contact support${adminEmail ? ` at ${adminEmail}` : ''} if you believe this is an error.`,
            });

            return;
          }

          if (!user || (!user.isActive && !user.isResumable)) {
            done({ message: 'We could not find the nickname you provided.' });
          }

          // Here the user is active or is resumable

          const validPwd = await user.validPassword(clearPassword);

          if (!validPwd) {
            done({
              message: user.isActive
                ? 'The password you provided does not match the password in our system.'
                : 'We could not find the nickname you provided.',
            });
            return;
          }

          if (user.isResumable) {
            done({
              message: 'Your account is now inactive but you can resume it.',
              userId: user.id,
              isResumable: true,
            });
            return;
          }

          done(null, user);
        } catch {
          done({ message: 'We could not find the nickname you provided.' });
        }
      },
    ),
  );
}
