import { test as setup, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ONE-TIME (per session lifetime) AUTH SETUP.
 *
 * Reads credentials from .env, drives the real login once, then saves the
 * logged-in browser session (cookies + localStorage) to state.json.
 * Every other test then reuses that session and skips login entirely.
 *
 * Re-run this whenever the saved session expires:  npm run auth
 *
 * Selectors below were confirmed working live against
 * https://kiki.serviceassistant.com/809961/Login (ServiceAssistant/RealGreen,
 * Healthy Lawn NJ) on 2026-07-06 — same login flow as the sibling
 * "Healthy Lawn SA lead source sync" project's auth.setup.ts.
 */

const authFile = 'playwright/.auth/state.json';

setup('authenticate', async ({ page }) => {
  const { LOGIN_URL, SAP_USER, SAP_PASS } = process.env;

  if (!LOGIN_URL || !SAP_USER || !SAP_PASS) {
    throw new Error(
      'Missing LOGIN_URL / SAP_USER / SAP_PASS. Copy .env.example to .env and fill it in.',
    );
  }

  // Make sure the folder for the saved session exists.
  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  await page.goto(LOGIN_URL);

  await page.getByRole('textbox', { name: 'Username' }).fill(SAP_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(SAP_PASS);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Reliability: wait for a concrete "I am logged in" signal, not a fixed sleep.
  // Login redirects from /Login to the account root (e.g. /809961/).
  await page.waitForURL(/\/809961\/?$/, { timeout: 60_000 });

  await page.context().storageState({ path: authFile });
  console.log(`Saved authenticated session to ${authFile}`);
});
