global.$database = require('../app/setup/database').default; // used by realtime-tests

global.$should = require('chai').should();
global.$postgres = require('../app/setup/postgres');

global.$pg_database = global.$postgres.connect();

// Show stack not only for errors, but also for warnings
process.on('warning', (e) => console.warn(e.stack));
