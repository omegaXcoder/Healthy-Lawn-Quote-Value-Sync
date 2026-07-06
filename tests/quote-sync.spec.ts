import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fetchQualifyingLeads, resolveDateRange, updateLead, WhatConvertsLead } from '../lib/whatconverts';
import { emailLog } from '../lib/mailer';

/**
 * Healthy Lawn NJ — WhatConverts -> ServiceAssistant quote/sale value sync.
 *
 * Ports "Summit Quote Value Automation" (which targets Service Autopilot) to
 * the ServiceAssistant/RealGreen CRM this client uses instead. Same idea:
 * pull recent quotable WhatConverts leads, look each one up in the CRM, and
 * write back a quote_value (and, if the work was actually sold, a matching
 * sales_value) so WhatConverts can report on close rate and job value.
 *
 * Where ServiceAssistant differs from Service Autopilot: there's no separate
 * "click into each job" or "click into the estimate" step — the Customer
 * Details page's "Services" panel (#DetailServices) already lists every
 * program/package for the year with its own status badge and dollar Total,
 * confirmed live 2026-07-06:
 *   - .card-inner.status-active   -> sold/active package (counts as a job)
 *   - .card-inner.status-estimate -> estimate given, not yet sold
 *   - anything else (e.g. cancelled) -> excluded from both totals
 * If ANY card is status-active, we sum those totals as quote_value AND
 * sales_value (the work was sold). Otherwise, if any card is status-estimate,
 * we sum those as quote_value only (per client instruction: no per-service
 * multiplier math here — just add the package totals together, matching how
 * this client's RealGreen totals already roll up rounds/year on their own).
 *
 * Dry run (default): looks the lead up, computes what would be written, and
 * LOGS it. Never calls the WhatConverts update endpoint.
 * Live run: set LIVE_RUN=true. Then it actually PATCHes quote_value/sales_value
 * (or a "no estimate given" note) for every found lead that doesn't already
 * have a sales_value set (that filter also runs server-side via the API).
 *
 * Run with:  npm run sync:dry   (or sync:live)
 */

const LIVE_RUN = process.env.LIVE_RUN === 'true';

interface LogEntry {
  leadId: number;
  leadType: string;
  contact: string;
  phone: string;
  status: string; // NOT_FOUND | AMBIGUOUS | WOULD_UPDATE | UPDATED | NOTED_NO_VALUE | ERROR
  detail: string;
}

const log: LogEntry[] = [];

function digits(phone: string): string {
  return (phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

function parseCurrency(text: string): number | null {
  const match = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

/** Runs the Customer Search form with a single field, returns what happened.
 * Identical search mechanics to the sibling "Healthy Lawn SA lead source
 * sync" project's tests/sync.spec.ts — same CRM, same search page. */
async function runSearch(
  page: Page,
  field: 'phone' | 'email' | 'lastName',
  value: string,
): Promise<'navigated' | 'single' | 'multiple' | 'none'> {
  // NOTE: no leading slash — a leading slash would resolve against the origin
  // and drop the /809961/ account segment from baseURL.
  await page.goto('Customer/Search/Index');

  // Clear any sticky filter from a previous search so results aren't AND-filtered
  // (confirmed live on the sibling project: a stale phone#/name filter silently
  // ANDs with the next search — a plain reload does NOT clear it, this link does).
  const clearStickyLink = page.getByRole('link', { name: 'Clear Sticky settings for this page' });
  if (await clearStickyLink.isVisible().catch(() => false)) {
    await clearStickyLink.click();
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  await page.goto('Customer/Search/Index');

  if (field === 'phone') {
    await page.getByRole('textbox', { name: 'Phone #:' }).fill(digits(value));
  } else if (field === 'email') {
    await page.getByRole('textbox', { name: 'Email:' }).fill(value);
  } else {
    await page.getByRole('textbox', { name: 'Last name:' }).fill(value);
  }

  await page.locator('form').getByText('Search', { exact: true }).click();
  await page.waitForTimeout(1500); // settle: results grid renders client-side after the AJAX search

  if (/\/Customer\/Customer\/Index\/\d+\/Detail/.test(page.url())) return 'navigated';

  const noResults = page.getByRole('heading', { name: 'No Results Found.' });
  if (await noResults.isVisible().catch(() => false)) return 'none';

  const rows = page.locator('[role="grid"] tbody tr, [role="grid"] [role="row"]').filter({ has: page.locator('a') });
  const count = await rows.count().catch(() => 0);
  if (count === 0) return 'none';
  if (count === 1) {
    await rows.first().locator('a').first().click();
    await page.waitForTimeout(1500);
    return 'single';
  }
  return 'multiple';
}

/** Finds the matching customer for a lead. Search order mirrors Summit Quote
 * Value Automation's sa_scraper.lookup_lead: Phone Call leads search phone
 * only; every other lead type tries phone, then email, then last name. */
async function findCustomer(page: Page, lead: WhatConvertsLead): Promise<boolean> {
  const isPhoneCall = /phone|call/i.test(lead.lead_type);

  if (lead.phone_number) {
    const r = await runSearch(page, 'phone', lead.phone_number);
    if (r === 'navigated' || r === 'single') return true;
    if (r === 'multiple') {
      log.push({ leadId: lead.lead_id, leadType: lead.lead_type, contact: lead.contact_name, phone: lead.phone_number, status: 'AMBIGUOUS', detail: 'Multiple customers matched by phone — needs manual review' });
      return false;
    }
  }

  if (isPhoneCall) return false; // Phone Call leads: phone-only, matches Summit's behavior

  if (lead.email_address) {
    const r = await runSearch(page, 'email', lead.email_address);
    if (r === 'navigated' || r === 'single') return true;
    if (r === 'multiple') {
      log.push({ leadId: lead.lead_id, leadType: lead.lead_type, contact: lead.contact_name, phone: lead.phone_number, status: 'AMBIGUOUS', detail: 'Multiple customers matched by email — needs manual review' });
      return false;
    }
  }

  if (lead.contact_name && lead.contact_name.trim()) {
    const lastName = lead.contact_name.trim().split(/\s+/).pop()!;
    const r = await runSearch(page, 'lastName', lastName);
    if (r === 'navigated' || r === 'single') return true;
    if (r === 'multiple') {
      log.push({ leadId: lead.lead_id, leadType: lead.lead_type, contact: lead.contact_name, phone: lead.phone_number, status: 'AMBIGUOUS', detail: 'Multiple customers matched by last name — needs manual review' });
      return false;
    }
  }

  return false;
}

interface ServicesValue {
  kind: 'job' | 'estimate' | 'none';
  total: number;
  detail: string;
}

/** Reads the Customer Details page's "Services" panel (#DetailServices) and
 * sums package totals into a job value (sold/active) or estimate value
 * (given, not sold), per the card's own status-active / status-estimate
 * class — confirmed live 2026-07-06 against customers #1689 (active) and
 * #1511 (estimate-only, status "4 - Gave Estimate - Not Sold"). Cancelled
 * or other-status cards are intentionally excluded from both totals. */
async function readServicesValue(page: Page): Promise<ServicesValue> {
  const cards = page.locator('#DetailServices .cards .card');
  const count = await cards.count();
  if (count === 0) {
    return { kind: 'none', total: 0, detail: 'No Services cards on customer profile' };
  }

  let activeTotal = 0;
  let activeCount = 0;
  let estimateTotal = 0;
  let estimateCount = 0;

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const isActive = (await card.locator('.card-inner.status-active').count()) > 0;
    const isEstimate = (await card.locator('.card-inner.status-estimate').count()) > 0;

    const totalRow = card.locator('.detail-column .row').filter({ hasText: 'Total:' }).first();
    if (!(await totalRow.isVisible().catch(() => false))) continue;
    const value = parseCurrency(await totalRow.innerText());
    if (value === null) continue;

    if (isActive) {
      activeTotal += value;
      activeCount++;
    } else if (isEstimate) {
      estimateTotal += value;
      estimateCount++;
    }
    // else: cancelled or other status — intentionally not counted
  }

  if (activeCount > 0) {
    return { kind: 'job', total: activeTotal, detail: `${activeCount} active/sold package(s) totaling $${activeTotal.toFixed(2)}` };
  }
  if (estimateCount > 0) {
    return { kind: 'estimate', total: estimateTotal, detail: `${estimateCount} estimate package(s) totaling $${estimateTotal.toFixed(2)}` };
  }
  return { kind: 'none', total: 0, detail: `${count} package(s) found, none active or estimate status` };
}

test('Healthy Lawn NJ quote/sale value sync', async ({ page }) => {
  const range = resolveDateRange();
  const leads = await fetchQualifyingLeads(range);

  for (const lead of leads) {
    const base = { leadId: lead.lead_id, leadType: lead.lead_type, contact: lead.contact_name, phone: lead.phone_number };

    const found = await findCustomer(page, lead);
    if (!found) {
      const alreadyLogged = log.some((e) => e.leadId === lead.lead_id);
      if (!alreadyLogged) {
        log.push({ ...base, status: 'NOT_FOUND', detail: 'No CRM customer matched phone/email/name' });
      }
      continue;
    }

    let values: ServicesValue;
    try {
      values = await readServicesValue(page);
    } catch (exc) {
      log.push({ ...base, status: 'ERROR', detail: `Failed reading Services panel: ${(exc as Error).message}` });
      continue;
    }

    try {
      if (values.kind === 'job') {
        await updateLead(lead.lead_id, { quoteValue: values.total, salesValue: values.total }, LIVE_RUN);
        log.push({ ...base, status: LIVE_RUN ? 'UPDATED' : 'WOULD_UPDATE', detail: `quote_value=sales_value=$${values.total.toFixed(2)} (${values.detail})` });
      } else if (values.kind === 'estimate') {
        await updateLead(lead.lead_id, { quoteValue: values.total }, LIVE_RUN);
        log.push({ ...base, status: LIVE_RUN ? 'UPDATED' : 'WOULD_UPDATE', detail: `quote_value=$${values.total.toFixed(2)}, no sales_value (${values.detail})` });
      } else {
        await updateLead(lead.lead_id, { notes: 'no estimate given' }, LIVE_RUN);
        log.push({ ...base, status: LIVE_RUN ? 'NOTED_NO_VALUE' : 'WOULD_NOTE_NO_VALUE', detail: values.detail });
      }
    } catch (exc) {
      log.push({ ...base, status: 'ERROR', detail: `WhatConverts update failed: ${(exc as Error).message}` });
    }

    // Navigate back to a clean page before the next lead's search.
    await page.goto('Customer/Search/Index').catch(() => {});
  }

  const summary = [
    `Healthy Lawn NJ quote/sale value sync — ${LIVE_RUN ? 'LIVE RUN' : 'DRY RUN'}`,
    `Date range: ${range.start} to ${range.end}`,
    `Leads processed: ${leads.length}`,
    '',
    ...log.map((e) => `[${e.status}] lead ${e.leadId} (${e.leadType}, "${e.contact}", ${e.phone}): ${e.detail}`),
  ].join('\n');

  const logDir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `quote-sync-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  fs.writeFileSync(logFile, summary);
  console.log(summary);

  await emailLog(LIVE_RUN ? 'LIVE RUN' : 'DRY RUN', summary);

  expect(log.length).toBeGreaterThanOrEqual(0); // always passes; this test is a batch job, not a pass/fail check
});
