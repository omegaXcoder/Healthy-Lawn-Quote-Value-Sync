/**
 * WhatConverts REST API v1 client for the Healthy Lawn NJ quote/sale value sync.
 *
 * Mirrors the "Summit Quote Value Automation" Python client's behavior
 * (../Summit Quote Value Automation/whatconverts_client.py) so the two
 * automations stay in sync conceptually, just ported to TypeScript for this
 * project's Playwright-test-based stack.
 */

export interface WhatConvertsLead {
  lead_id: number;
  lead_type: string; // "Phone Call" | "Web Form" | "Chat" | ...
  lead_source: string;
  lead_medium: string;
  contact_name: string;
  phone_number: string;
  email_address: string;
  quotable: string;
  lead_status: string; // "unique" | "duplicate"
  sales_value: number | null;
}

export interface DateRange {
  start: string;
  end: string;
}

/** Resolves the run's date range: explicit START_DATE/END_DATE env vars win,
 * else the previous two full Sunday-Saturday weeks (matches Summit Quote
 * Value Automation's cadence: end = today-2, start = end-13). */
export function resolveDateRange(): DateRange {
  if (process.env.START_DATE && process.env.END_DATE) {
    return { start: process.env.START_DATE, end: process.env.END_DATE };
  }
  const end = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 13 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

export interface WhatConvertsCredentials {
  token: string;
  secret: string;
}

export function apiCredentials(): WhatConvertsCredentials {
  const { WHATCONVERTS_API_TOKEN, WHATCONVERTS_API_SECRET } = process.env;
  if (!WHATCONVERTS_API_TOKEN || !WHATCONVERTS_API_SECRET) {
    throw new Error('Missing WHATCONVERTS_API_TOKEN / WHATCONVERTS_API_SECRET in .env');
  }
  return { token: WHATCONVERTS_API_TOKEN, secret: WHATCONVERTS_API_SECRET };
}

function authHeader(creds: WhatConvertsCredentials): string {
  return 'Basic ' + Buffer.from(`${creds.token}:${creds.secret}`).toString('base64');
}

const BASE_URL = 'https://app.whatconverts.com/api/v1';

async function fetchLeadsPage(
  creds: WhatConvertsCredentials,
  profileId: string,
  quotable: 'yes' | 'pending',
  range: DateRange,
  pageNumber: number,
): Promise<{ leads: WhatConvertsLead[]; totalLeads: number }> {
  const url = new URL(`${BASE_URL}/leads`);
  url.searchParams.set('profile_id', profileId);
  url.searchParams.set('start_date', range.start);
  url.searchParams.set('end_date', range.end);
  url.searchParams.set('lead_status', 'unique');
  url.searchParams.set('quotable', quotable);
  url.searchParams.set('leads_per_page', '2500');
  url.searchParams.set('page_num', String(pageNumber));

  const res = await fetch(url, { headers: { Authorization: authHeader(creds) } });
  if (!res.ok) {
    throw new Error(`WhatConverts API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { leads: data.leads ?? [], totalLeads: Number(data.total_leads ?? 0) };
}

/** Pulls all unique, quotable=Yes/Pending leads for the date range, de-duped
 * by lead_id, then applies the client-side safety filter: unique, quotable,
 * and no sales_value already set (so a re-run never clobbers a value that
 * was already written, live or by hand). */
export async function fetchQualifyingLeads(
  range: DateRange,
  creds: WhatConvertsCredentials = apiCredentials(),
  profileId: string = process.env.WHATCONVERTS_PROFILE_ID ?? '',
): Promise<WhatConvertsLead[]> {
  if (!profileId) throw new Error('Missing profileId (and no WHATCONVERTS_PROFILE_ID in .env)');

  const byId = new Map<number, WhatConvertsLead>();

  for (const quotable of ['yes', 'pending'] as const) {
    let page = 1;
    let fetchedForThisQuotable = 0;
    while (true) {
      const { leads, totalLeads } = await fetchLeadsPage(creds, profileId, quotable, range, page);
      for (const lead of leads) byId.set(lead.lead_id, lead);
      fetchedForThisQuotable += leads.length;
      if (leads.length === 0 || fetchedForThisQuotable >= totalLeads) break;
      page++;
    }
  }

  const all = [...byId.values()];
  const filtered = all.filter((lead) => {
    const unique = String(lead.lead_status ?? '').toLowerCase() === 'unique';
    const quotable = ['yes', 'pending'].includes(String(lead.quotable ?? '').toLowerCase());
    const hasSalesValue = lead.sales_value !== null && lead.sales_value !== undefined && Number(lead.sales_value) > 0;
    return unique && quotable && !hasSalesValue;
  });

  return filtered;
}

export interface UpdateLeadPayload {
  quoteValue?: number;
  salesValue?: number;
  notes?: string;
}

/** Updates a lead's quote_value, sales_value, and/or notes in WhatConverts.
 * Returns true on success (or in dry-run mode, where nothing is sent). */
export async function updateLead(
  leadId: number | string,
  payload: UpdateLeadPayload,
  dryRun: boolean,
  creds: WhatConvertsCredentials = apiCredentials(),
): Promise<boolean> {
  const body: Record<string, unknown> = {};
  if (payload.quoteValue !== undefined) body.quote_value = Math.round(payload.quoteValue * 100) / 100;
  if (payload.salesValue !== undefined) body.sales_value = Math.round(payload.salesValue * 100) / 100;
  if (payload.notes !== undefined) body.notes = payload.notes;

  if (Object.keys(body).length === 0) return false;

  if (dryRun) return true;

  const res = await fetch(`${BASE_URL}/leads/${leadId}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`WhatConverts update failed for lead ${leadId}: ${res.status} ${await res.text()}`);
  }
  return true;
}
