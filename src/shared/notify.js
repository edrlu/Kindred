/* =========================================================
   Kindred — Trusted-Contact alert (single designated address)

   A safety / peace-of-mind feature. When Kindred detects a scam,
   or the elderly user taps "Tell my trusted contact", this sends
   ONE warm notification email to the SINGLE address the user (or
   their family) configured in Settings — a son, daughter, or
   caregiver.

   This is deliberately NOT a bulk mailer:
     - it only ever emails the one designated `trustedEmail`,
     - it is rate limited (one send / 30s, max 10 per session),
   so it can't be repurposed as a spam tool.

   Config is read at runtime from window.KindredProviders.getConfig()
   (defined in src/shared/providers.js, loaded first). Relevant
   fields: { resendKey, fromEmail, trustedEmail, trustedName }.

   Sends via the Resend email API:
     POST https://api.resend.com/emails
   ========================================================= */

(() => {
  "use strict";

  const RESEND_ENDPOINT = "https://api.resend.com/emails";

  // Resend's shared sender — works without domain verification, good
  // for testing. Users can override with their own verified domain.
  const DEFAULT_FROM = "Kindred <onboarding@resend.dev>";

  // Where we mirror the last-send timestamp so the 30s cooldown
  // survives a side-panel reload (module memory alone would reset).
  const LAST_SENT_KEY = "kindred.notify.lastSent";

  // Rate-limit policy. These are the guardrails that keep this from
  // being usable as a spam tool.
  const MIN_INTERVAL_MS = 30 * 1000; // at most one send per 30 seconds
  const MAX_PER_SESSION = 10;        // at most 10 sends per browser session

  // Basic "looks like an email" check — intentionally permissive.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const hasChromeStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  // In-memory state for the current page/session.
  let lastSentAt = 0;   // ms epoch of the most recent successful send
  let sessionCount = 0; // successful sends this session

  /* ---------- helpers ---------- */

  // Escape strings before inserting them into HTML, so a malicious
  // page title / URL / message can't inject markup into the email.
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Read the mirrored last-send timestamp from storage. Used to seed
  // `lastSentAt` if module memory was reset (e.g. panel reopened).
  async function readStoredLastSent() {
    try {
      if (hasChromeStorage) {
        return await new Promise((resolve) =>
          chrome.storage.local.get(LAST_SENT_KEY, (r) =>
            resolve(Number(r[LAST_SENT_KEY]) || 0)
          )
        );
      }
      return Number(localStorage.getItem(LAST_SENT_KEY)) || 0;
    } catch {
      return 0;
    }
  }

  // Persist the last-send timestamp (best effort).
  function writeStoredLastSent(ts) {
    try {
      if (hasChromeStorage) {
        chrome.storage.local.set({ [LAST_SENT_KEY]: ts });
      } else {
        localStorage.setItem(LAST_SENT_KEY, String(ts));
      }
    } catch {
      /* non-fatal — module memory still enforces the cooldown */
    }
  }

  // The most recent send time we know about, taking the larger of
  // module memory and the mirrored storage value.
  async function effectiveLastSent() {
    const stored = await readStoredLastSent();
    return Math.max(lastSentAt, stored);
  }

  /* ---------- email body ---------- */

  // Build a calm, readable HTML email plus a plain-text fallback,
  // written for a worried family member. All page/user-derived
  // strings are escaped on the way in.
  function buildEmail({ greetingName, message, pageTitle, pageUrl }) {
    const safeName = escapeHtml(greetingName);
    const safeMessage = escapeHtml(message);
    const safeTitle = pageTitle ? escapeHtml(pageTitle) : "";
    const safeUrl = pageUrl ? escapeHtml(pageUrl) : "";

    // Optional "where they were" block, only if we have page context.
    let contextHtml = "";
    if (safeTitle || safeUrl) {
      contextHtml =
        '<div style="margin:24px 0;padding:16px 20px;background:#f4f6fb;' +
        'border-radius:12px;">' +
        '<p style="margin:0 0 6px;font-size:15px;color:#555;">' +
        "They were on this page:</p>";
      if (safeTitle) {
        contextHtml +=
          '<p style="margin:0;font-size:18px;font-weight:600;color:#222;">' +
          safeTitle +
          "</p>";
      }
      if (safeUrl) {
        contextHtml +=
          '<p style="margin:6px 0 0;font-size:15px;word-break:break-all;">' +
          '<a href="' + safeUrl + '" style="color:#3057d6;">' + safeUrl + "</a></p>";
      }
      contextHtml += "</div>";
    }

    const html =
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
      'max-width:560px;margin:0 auto;padding:8px;color:#222;line-height:1.6;">' +
        '<p style="font-size:20px;margin:0 0 18px;">Hi ' + safeName + ",</p>" +
        '<p style="font-size:18px;margin:0 0 18px;">' +
          "Kindred is reaching out on behalf of your loved one. Kindred is an " +
          "accessibility assistant they have installed to help them browse the web " +
          "safely. They asked it to let you know about this:" +
        "</p>" +
        '<div style="margin:24px 0;padding:20px 24px;background:#fff6e9;' +
          'border-left:4px solid #f0a020;border-radius:8px;font-size:19px;color:#222;">' +
          safeMessage +
        "</div>" +
        contextHtml +
        '<p style="font-size:18px;margin:24px 0 0;">' +
          "It might be a good moment to check in with them." +
        "</p>" +
        '<p style="font-size:15px;color:#888;margin:28px 0 0;border-top:1px solid #eee;padding-top:16px;">' +
          "Sent automatically by Kindred at your loved one's request. " +
          "You are receiving this because you are their designated trusted contact." +
        "</p>" +
      "</div>";

    // Plain-text fallback (use the raw, un-escaped values — escaping
    // is only needed for HTML).
    let text =
      "Hi " + greetingName + ",\n\n" +
      "Kindred is reaching out on behalf of your loved one. Kindred is an " +
      "accessibility assistant they have installed to help them browse the web " +
      "safely. They asked it to let you know about this:\n\n" +
      "  " + message + "\n";
    if (pageTitle) text += "\nThey were on this page: " + pageTitle + "\n";
    if (pageUrl) text += (pageTitle ? "" : "\n") + pageUrl + "\n";
    text +=
      "\nIt might be a good moment to check in with them.\n\n" +
      "— Sent automatically by Kindred at your loved one's request. " +
      "You are receiving this because you are their designated trusted contact.";

    return { html, text };
  }

  /* ---------- public API ---------- */

  // True only if BOTH a Resend key and a trusted email are present.
  async function isConfigured() {
    if (!window.KindredProviders || typeof window.KindredProviders.getConfig !== "function") {
      return false;
    }
    try {
      const c = await window.KindredProviders.getConfig();
      return Boolean(
        c && c.resendKey && c.resendKey.trim() &&
        c.trustedEmail && c.trustedEmail.trim()
      );
    } catch {
      return false;
    }
  }

  // Send a single alert to the trusted contact.
  // Returns { ok, error?, skipped? }.
  async function sendAlert({ subject, message, pageUrl, pageTitle, to } = {}) {
    // Config layer must be present.
    if (!window.KindredProviders || typeof window.KindredProviders.getConfig !== "function") {
      return { ok: false, error: "Kindred isn't fully loaded yet. Please try again in a moment." };
    }

    let cfg;
    try {
      cfg = await window.KindredProviders.getConfig();
    } catch {
      return { ok: false, error: "Couldn't read Kindred's settings. Please try again." };
    }

    const resendKey = (cfg.resendKey || "").trim();
    const recipient = (to || cfg.trustedEmail || "").trim();

    // Need both a key and a recipient.
    if (!recipient || !resendKey) {
      return { ok: false, error: "Add a Resend API key and a trusted contact email in Settings." };
    }

    // Recipient must look like an email.
    if (!EMAIL_RE.test(recipient)) {
      return { ok: false, error: "The trusted contact email doesn't look valid." };
    }

    // ---- rate limiting (checked BEFORE any network call) ----
    const now = Date.now();
    const since = now - (await effectiveLastSent());
    if (since < MIN_INTERVAL_MS || sessionCount >= MAX_PER_SESSION) {
      return { ok: false, skipped: "Just sent an alert — please wait a moment before sending another." };
    }

    // ---- build the message ----
    const from = (cfg.fromEmail || "").trim() || DEFAULT_FROM;
    const greetingName = (cfg.trustedName || "").trim() || "there";
    const safeSubject = (subject && String(subject).trim()) || "Kindred — a quick heads-up about your loved one";
    const safeMessage = (message && String(message).trim()) ||
      "Your loved one wanted to share something with you through Kindred.";

    const { html, text } = buildEmail({
      greetingName,
      message: safeMessage,
      pageTitle,
      pageUrl,
    });

    // ---- send via Resend ----
    let res;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + resendKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: recipient,
          subject: safeSubject,
          html,
          text,
        }),
      });
    } catch {
      // Network-level failure (offline, DNS, CORS, etc.).
      return { ok: false, error: "Couldn't reach the email service. Please check your connection and try again." };
    }

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, error: "Resend key was rejected. Check it in Settings. (401)" };
      }
      if (res.status === 429) {
        return { ok: false, error: "Email service is rate limited. Please try again shortly. (429)" };
      }
      let detail = "";
      try {
        const data = await res.json();
        detail = (data && (data.message || data.error)) || "";
      } catch {
        /* ignore — status alone is enough for a friendly message */
      }
      return {
        ok: false,
        error: ("Couldn't send the alert (" + res.status + "). " + detail).trim(),
      };
    }

    // ---- success: record the send for rate limiting ----
    lastSentAt = now;
    sessionCount += 1;
    writeStoredLastSent(now);
    return { ok: true };
  }

  window.KindredNotify = {
    isConfigured,
    sendAlert,
  };
})();
