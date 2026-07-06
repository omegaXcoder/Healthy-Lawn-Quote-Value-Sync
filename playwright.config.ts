import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

// Load secrets/config from .env into process.env
dotenv.config();

/**
 * Reliability-first configuration.
 * The priority here is "correct-but-slow beats fast-but-flaky".
 * Timeouts are deliberately generous and tasks run serially so a slow
 * backend never causes a false failure.
 */
export default defineConfig({
  testDir: './tests',

  // Run serially, not in parallel. Stateful business apps (CRMs, quoting
  // tools) don't like concurrent sessions, and serial runs are more predictable.
  fullyParallel: false,
  workers: 1,

  // Retry a failed test rather than giving up — absorbs transient glitches.
  retries: 2,

  // Generous per-test ceiling (30 min) — this "test" walks every qualifying
  // lead's CRM customer page in one batch, so the runtime scales with lead
  // volume, not with a fixed number of assertions like a normal test.
  timeout: 1_800_000,

  expect: {
    // How long expect(...).toBeVisible() etc. will wait for a condition.
    timeout: 20_000,
  },

  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: process.env.BASE_URL,

    // Generous action + navigation timeouts so slow pages don't error out.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,

    // Capture evidence when something does go wrong.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // 1) Auth setup — logs in once (using .env) and saves the session.
    //    Runs before everything else via the `dependencies` below.
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },

    // 2) The actual automation — starts already logged in via storageState.
    {
      name: 'chromium',
      testIgnore: /auth\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/state.json',
      },
      dependencies: ['setup'],
    },
  ],
});
