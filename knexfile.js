require('tsx/cjs');
const { loadFileConfigs } = require('config').util;

let env = process.env.NODE_ENV || 'development';

{
  // Knex can read environment from the '--env' option
  const args = process.argv.slice(2);
  const p = args.indexOf('--env');

  if (p >= 0 && p < args.length - 1) {
    env = args[p + 1];
  }
}

const prevEnv = process.env.NODE_ENV;
process.env.NODE_ENV = env;
module.exports = { [env]: loadFileConfigs().postgres };
process.env.NODE_ENV = prevEnv;
