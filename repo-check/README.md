# Maruti — Inspection Report Builder

A self-contained fire/life-safety inspection report tool: fill in device-level
inspection data (Fire Alarm, plus configurable types like Extinguisher, Pump,
Sprinkler, etc.), get auto-calculated summary tables, and export a branded PDF.
Includes a full Customers CRM (Billing Location → Service Location → Job
Ticket → Reports) backed by a Google Sheet.

## Project structure

```
index.html            The entire app — single-file HTML/CSS/JS, no build step.
api/gs.js              Vercel serverless function. Proxies calls to the Apps
                        Script backend so the browser never talks to Google
                        directly (avoids a CORS/redirect issue on Google's side).
google-apps-script/
  Code.gs               NOT deployed by Vercel — this is the source of truth
                        for the Apps Script Web App backend. Copy its contents
                        into the Sheet's Extensions → Apps Script editor.
```

## Deploying

### 1. Backend (Google Sheet + Apps Script)

1. Open (or create) a Google Sheet to act as the database.
2. Extensions → Apps Script, paste in `google-apps-script/Code.gs`, save.
3. Deploy → New deployment → Web app.
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the Web app URL (ends in `/exec`).

If you update `Code.gs` later, don't create a new deployment — use
**Deploy → Manage deployments → (edit) → Version: New version → Deploy** so
the `/exec` URL stays the same and nothing else needs updating.

### 2. Frontend (Vercel)

1. Push this repo to Vercel (import the GitHub repo directly, or `vercel` CLI
   from this folder). No build command needed — it's static + one API route.
2. Vercel auto-detects `api/gs.js` as a serverless function.
3. Set the backend URL one of two ways:
   - **Environment variable** (recommended): in Vercel project settings, add
     `APPS_SCRIPT_URL` = your `/exec` URL. No code changes needed after that.
   - **Or** edit `DEFAULT_APPS_SCRIPT_URL` near the top of `index.html`'s
     `<script>` block directly, and edit the fallback URL at the top of
     `api/gs.js`.
4. Deploy. Visit the Vercel URL — the Customers tab should connect
   automatically with no manual URL paste.

## Notes

- Everything runs client-side except the two small server hops in `api/gs.js`
  (proxying to Apps Script) — there's no other backend.
- The Fire Alarm Inspection report type is built into the app directly (its
  own dedicated calculation engine) and isn't editable through the Report
  Types configurator. Other report types (Extinguisher, Pump, Sprinkler,
  Kitchen Hood, Emergency Lighting, Backflow, Dampers, Standpipe, Clean
  Agent) are configured there — fields and repeatable tables, no code needed
  per type.
