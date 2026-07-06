Healthy Lawn NJ — WhatConverts -> ServiceAssistant Quote/Sale Value Sync
=========================================================================

WHAT THIS DOES
--------------
Pulls unique, qualified (Yes/Pending) WhatConverts leads for the previous two
full Sunday-Saturday weeks, finds the matching customer in the ServiceAssistant
CRM (kiki.serviceassistant.com/809961), reads their "Services" panel, and
writes a quote_value (and, if the work was actually sold, a matching
sales_value) back to WhatConverts.

This is the ServiceAssistant/RealGreen port of "Summit Quote Value
Automation" (../Summit Quote Value Automation), which does the same thing
against Service Autopilot for other clients. Same idea, different CRM:

  - ServiceAssistant's Customer Details page already lists every
    program/package for the year with a status badge and a dollar Total —
    no separate "click into each job" or "click into the estimate" step
    like Service Autopilot needs.
  - If ANY package is sold/active (status-active), we sum those totals as
    BOTH quote_value and sales_value.
  - Otherwise, if any package is an estimate not yet sold (status-estimate),
    we sum those as quote_value only (no sales_value).
  - Per client instruction, there is no per-service "rounds/year" multiplier
    here (unlike some Summit clients) — RealGreen's own package Total
    already reflects the full package price, so we just add totals together.

SETUP (one time)
-----------------
1. cp .env.example .env   (already done in this environment — real values are in .env)
2. npm install
3. npm run auth            -- logs in once, saves session to playwright/.auth/state.json
                               Re-run this whenever the saved session expires
                               (login errors when running sync).

COMMANDS
--------
npm run sync:dry           -- DRY RUN (default & recommended first). Searches the
                               CRM and reports what it WOULD write to WhatConverts.
                               Never calls the WhatConverts update endpoint.
                               Emails + writes a log to logs/.

npm run sync:dry:headed    -- Same as above but shows the browser window, useful
                               for watching a run or debugging.

npm run sync:live          -- LIVE RUN. Actually writes quote_value/sales_value
                               (or a "no estimate given" note) to WhatConverts for
                               every lead found in the CRM. Only run this after
                               reviewing a dry run's log.

npm run sync:live:headed   -- Live run, visible browser.

npm run report             -- Opens the Playwright HTML report from the last run
                               (screenshots/trace/video on failure).

OVERRIDING THE DATE RANGE
--------------------------
By default the sync uses the previous two full Sunday-Saturday weeks (matches
Summit Quote Value Automation's cadence). To override for a backfill or
reprocessing:

  (Windows, PowerShell)
  $env:START_DATE="2026-06-01"; $env:END_DATE="2026-06-14"; npm run sync:dry

  (Git Bash / macOS / Linux)
  START_DATE=2026-06-01 END_DATE=2026-06-14 npm run sync:dry

LOGS
----
Every run writes a plain-text log to logs/quote-sync-<timestamp>.txt and emails
the same content to omega@kudos.marketing with subject "AUTOMATION LOGGING -
Healthy Lawn NJ Quote Value Sync - DRY RUN" (or "LIVE RUN"), matching the
existing email filter rule. Every lead is logged as exactly one of:

  NOT_FOUND            No CRM customer matched phone/email/name (or phone
                       alone, for Phone Call leads). Nothing was touched.
  AMBIGUOUS            More than one CRM customer matched — skipped, needs a
                       human.
  WOULD_UPDATE         Dry run only: this is what a live run would write
                       (quote_value and/or sales_value).
  UPDATED              Live run only: quote_value/sales_value was written.
  WOULD_NOTE_NO_VALUE  Dry run only: customer found but has no active or
                       estimate packages — a live run would add a
                       "no estimate given" note instead of a dollar value.
  NOTED_NO_VALUE       Live run only: the "no estimate given" note was written.
  ERROR                Something failed reading the CRM page or writing back
                       to WhatConverts — check the log detail and screenshot
                       (playwright-report/) for specifics.

Leads that the WhatConverts API filter already excludes (not unique, not
quotable yes/pending, or already have a sales_value set) never appear in the
log at all — a re-run is always safe and will not overwrite a value someone
already set, live or by hand.

SCHEDULING (GitHub Actions)
----------------------------
The workflow file is at .github/workflows/quote_value_sync.yml.

It runs automatically every Monday at 7 AM Central Time, as a LIVE run.

GitHub Secrets required (Settings -> Secrets and variables -> Actions):

  BASE_URL                  https://kiki.serviceassistant.com/809961/
  LOGIN_URL                 https://kiki.serviceassistant.com/809961/Login
  SAP_USER                  ServiceAssistant login username
  SAP_PASS                  ServiceAssistant login password
  WHATCONVERTS_API_TOKEN    WhatConverts API token
  WHATCONVERTS_API_SECRET   WhatConverts API secret
  WHATCONVERTS_PROFILE_ID   152222 (Healthy Lawn NJ)
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_TO

Manual trigger (Actions -> Quote Value Sync -> Run workflow):

  dry_run     "false" (default) runs LIVE and writes to WhatConverts.
              "true" runs a dry run — logs everything, writes nothing.
  date_from / date_to
              Both optional. Leave blank to use the default previous-two-weeks
              range. Fill in both to override (e.g. for a backfill).

Scheduled (cron) runs always execute LIVE — there's no dry-run option on a
schedule trigger, so use "Run workflow" with dry_run=true whenever you want to
preview a run before it writes anything.

Logs and the Playwright HTML report are uploaded as a run artifact
(run-logs-{run_id}), retained for 30 days.

Timezone note: the cron is set to `0 13 * * 1` (1 PM UTC = 7 AM CDT). During
Central Standard Time (November-March) you may want to change it to
`0 12 * * 1` (6 AM CST = noon UTC) to keep the 7 AM local time.

KNOWN LIMITATIONS
------------------
- The Services panel's year selector defaults to the current year. If the
  office backdates a sale into a prior year before this sync runs, that
  package won't be counted. Given the ~2-week lookback window this should be
  rare, but if a WOULD_UPDATE/UPDATED total looks low for a customer you know
  has more history, check the CRM's year dropdown by hand.
- Packages with any other status (e.g. cancelled) are intentionally excluded
  from both quote_value and sales_value.

FILES
-----
lib/whatconverts.ts    WhatConverts API client (date range, lead fetch, lead update).
lib/mailer.ts          Sends the run log via SMTP.
tests/auth.setup.ts    One-time login, saves session.
tests/quote-sync.spec.ts  The actual sync (dry run by default).
