/**
 * Manual Jest mock for src/utils/config.js.
 *
 * Uses a global singleton so that the same mock object is returned across
 * jest.resetModules() calls within a single test file. This lets tests assign
 * to the module-level `config` reference (captured before any resetModules)
 * and have those assignments visible to freshly-required modules.
 */

/* global jest */

if (!global.__configMockSingleton) {
  global.__configMockSingleton = {
    validateEnv: jest.fn(() => ({ budgetRevertRemindersEnabled: true })),
    REQUIRED_VARS: [],
  };
}

module.exports = global.__configMockSingleton;
