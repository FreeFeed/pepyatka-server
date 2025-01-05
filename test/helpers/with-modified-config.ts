import { Config } from 'config';
import { after, before } from 'mocha';
import { merge, noop } from 'lodash';

import { DeepPartial } from '../../app/support/types';
import { currentConfig, setExplicitConfig } from '../../app/support/app-async-context';

/**
 * Run tests in 'describe' block with modified config. Use it only in
 * 'describe', not in test functions!
 *
 * Unlike the `withModifiedAppConfig` (from functional_test_helpers.js), this
 * method is not related to the FreefeedApp instance, and can be used in
 * integration or unit tests. In all test in the given 'describe' block, the
 * currentConfig() function will return the patched config.
 */
export function withModifiedConfig(patch: DeepPartial<Config> | (() => DeepPartial<Config>)) {
  let rollback: () => void = noop;
  before(() => {
    if (typeof patch === 'function') {
      patch = patch();
    }

    const modifiedConfig = merge({}, currentConfig(), patch);
    rollback = setExplicitConfig(modifiedConfig);
  });

  after(() => rollback());
}
