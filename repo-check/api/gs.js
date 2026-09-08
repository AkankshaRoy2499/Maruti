// /api/gs.js
// Same-origin proxy to the Apps Script Web App backend.
// The browser calls this (same domain as the site → no CORS issue possible),
// and this function does the actual call to Google server-side, where CORS
// doesn't apply at all (CORS is a browser-only concept).
//
// Optional: set an APPS_SCRIPT_URL environment variable in your Vercel project
// settings to override the URL below without editing code.

const FALLBACK_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyV9DRjFoJapkB49ZlxUsO-cqR0wyYsOnLlDwaI6jq72NbFrdOZZZRu6SVC6GP1smUo/exec';

export default async function handler(req, res) {
  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || FALLBACK_APPS_SCRIPT_URL;

  try {
    if (req.method === 'GET') {
      const qs = new URLSearchParams(req.query).toString();
      const upstream = await fetch(`${APPS_SCRIPT_URL}?${qs}`);
      const text = await upstream.text();
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(text);
      return;
    }

    if (req.method === 'POST') {
      // Frontend sends Content-Type: text/plain with a JSON string body (to dodge
      // Apps Script's own CORS preflight handling) — Vercel puts that raw string
      // straight into req.body, so we just forward it as-is.
      const bodyText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      const upstream = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: bodyText
      });
      const text = await upstream.text();
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(text);
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
