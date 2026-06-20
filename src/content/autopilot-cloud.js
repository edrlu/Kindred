/* =========================================================
   Kindred — Website Autopilot (cloud, no backend)

   A SKELETON / MVP that drives a Browserbase cloud browser straight from the
   side panel — no server. It:
     1. creates a Browserbase session   (REST: POST /v1/sessions)
     2. opens the interactive Live View (REST: GET  /v1/sessions/:id/debug)
        embedded in an iframe so the user can LOG IN / take over by hand
     3. connects to the session over raw CDP (a WebSocket to connectUrl)
     4. answers the same KINDRED_AUTOPILOT_* messages the on-page executor does,
        so agent.js can drive it with the exact same Claude loop.

   This is intentionally minimal: raw CDP + page-side JS via Runtime.evaluate,
   rather than Playwright/Stagehand (which need Node). Good enough to demo,
   not hardened for production.

   Requires in Settings (kindred.config):
     autopilotCloud: true, browserbaseKey: "bb_...", browserbaseProjectId: "..."
   And in manifest.json:  host_permissions += "https://api.browserbase.com/*"
   (plus, only if you set a custom extension_pages CSP, allow
    connect-src wss://*.browserbase.com https://api.browserbase.com and
    frame-src https://*.browserbase.com).
   ========================================================= */

(() => {
  "use strict";

  const API = "https://api.browserbase.com/v1";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Browserbase REST (works from the extension via host_permissions) */
  async function bbFetch(path, apiKey, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || "GET",
      headers: { "x-bb-api-key": apiKey, "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 401) throw new Error("Browserbase key was rejected. Check it in Settings.");
      throw new Error(`Browserbase ${path} failed (${res.status}). ${detail}`.trim());
    }
    return res.status === 204 ? null : res.json();
  }

  /* ---------- a tiny CDP-over-WebSocket client (flattened sessions) ---------- */
  function makeCDP(ws) {
    let nextId = 0;
    let sessionId = null;
    const pending = new Map();

    ws.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
        else p.resolve(msg.result);
      }
      // events (msg.method) are ignored — this skeleton polls instead
    });

    function send(method, params, sid) {
      const id = ++nextId;
      const message = { id, method, params: params || {} };
      const use = sid === undefined ? sessionId : sid; // pass null to target the browser
      if (use) message.sessionId = use;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { ws.send(JSON.stringify(message)); } catch (err) { pending.delete(id); reject(err); }
      });
    }
    return { send, setSession: (s) => { sessionId = s; } };
  }

  function openWs(url) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { return reject(e); }
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", () => reject(new Error("Couldn't connect to the cloud browser.")), { once: true });
    });
  }

  /* ---------- functions that run INSIDE the remote page (via Runtime.evaluate)
     They must be self-contained (no closure refs) because we stringify them. */

  function kbObserve() {
    var AID = "data-kindred-aid";
    var sel = "a[href],button,[role=button],[role=link],[role=tab],[role=menuitem]," +
      "[role=checkbox],[role=radio],input,select,textarea,[contenteditable]";
    function vis(el) {
      try {
        var r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        var s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity || "1") === 0) return false;
        if (r.bottom < -40 || r.top > (window.innerHeight + 40)) return false;
        return true;
      } catch (e) { return false; }
    }
    function label(el) {
      try {
        var t = el.getAttribute("aria-label") || el.innerText || el.value ||
          el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
        return String(t).replace(/\s+/g, " ").trim().slice(0, 80);
      } catch (e) { return ""; }
    }
    var nodes;
    try { nodes = document.querySelectorAll(sel); } catch (e) { nodes = []; }
    var els = [], c = 0;
    for (var i = 0; i < nodes.length && els.length < 120; i++) {
      var el = nodes[i];
      if (!vis(el)) continue;
      var id = "a" + (c++);
      try { el.setAttribute(AID, id); } catch (e) { continue; }
      els.push({
        id: id,
        label: label(el),
        role: (el.getAttribute("role") || el.tagName.toLowerCase()),
        tag: el.tagName.toLowerCase(),
        value: String(el.value || "").slice(0, 60),
      });
    }
    var text = "";
    try { text = (document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim().slice(0, 3000); } catch (e) {}
    return { url: location.href, title: document.title, elements: els, text: text };
  }

  function kbAct(action) {
    var AID = "data-kindred-aid";
    function find(id) { try { return id ? document.querySelector("[" + AID + '="' + id + '"]') : null; } catch (e) { return null; } }
    try {
      var el = find(action.id);
      if (action.type === "click") {
        if (!el) return { ok: false, error: "element not found" };
        try { el.scrollIntoView({ block: "center" }); } catch (e) {}
        el.click();
        return { ok: true };
      }
      if (action.type === "type") {
        if (!el) return { ok: false, error: "element not found" };
        try { el.focus(); } catch (e) {}
        el.value = action.text || "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      if (action.type === "select") {
        if (!el) return { ok: false, error: "element not found" };
        el.value = action.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      if (action.type === "scroll") {
        window.scrollBy(0, (action.direction === "up" ? -1 : 1) * Math.round(window.innerHeight * 0.8));
        return { ok: true };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* ---------- Live View iframe, injected into the side panel's run panel ----- */
  function mountLiveView(url) {
    const anchor = document.getElementById("run-log");
    const panel = document.getElementById("run-panel") || document.body;
    let box = document.getElementById("kindred-liveview");
    if (!box) {
      box = document.createElement("div");
      box.id = "kindred-liveview";
      box.style.cssText =
        "margin:12px 0;border:1px solid #e6e6e6;border-radius:12px;overflow:hidden;background:#fff;";
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor);
      else panel.appendChild(box);
    }
    box.innerHTML = "";
    const head = document.createElement("div");
    head.textContent = "Live browser — click and type here to log in or take over";
    head.style.cssText =
      "font:600 12px -apple-system,system-ui,sans-serif;padding:8px 10px;color:#555;border-bottom:1px solid #eee;";
    box.appendChild(head);
    if (url) {
      const frame = document.createElement("iframe");
      frame.src = url;
      frame.setAttribute("allow", "clipboard-read; clipboard-write");
      frame.style.cssText = "display:block;width:100%;height:380px;border:0;";
      box.appendChild(frame);
    } else {
      const note = document.createElement("div");
      note.textContent = "Live view wasn't available for this session.";
      note.style.cssText = "padding:10px;font:13px -apple-system,system-ui,sans-serif;color:#888;";
      box.appendChild(note);
    }
  }
  function unmountLiveView() {
    const box = document.getElementById("kindred-liveview");
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  /* ---------- public: create a cloud driver the agent loop can talk to ------- */
  async function create({ apiKey, projectId, startUrl, onLog }) {
    onLog = onLog || (() => {});
    if (!apiKey) throw new Error("Add your Browserbase API key in Settings to use the cloud browser.");

    // 1) Create a session. projectId is recommended; the API will tell us if it's required.
    const session = await bbFetch("/sessions", apiKey, {
      method: "POST",
      body: projectId ? { projectId } : {},
    });
    const sid = session.id;
    const connectUrl = session.connectUrl;
    if (!connectUrl) throw new Error("Browserbase didn't return a connect URL.");
    const proj = projectId || session.projectId;

    let ws = null;
    try {
      // 2) Connect over raw CDP and attach to a page target (flattened sessions).
      ws = await openWs(connectUrl);
      const cdp = makeCDP(ws);
      const { targetInfos } = await cdp.send("Target.getTargets", {}, null);
      let page = (targetInfos || []).find((t) => t.type === "page");
      if (!page) {
        const created = await cdp.send("Target.createTarget", { url: "about:blank" }, null);
        page = { targetId: created.targetId };
      }
      const attached = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, null);
      cdp.setSession(attached.sessionId);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");

      // 3) Show the interactive Live View so the user can log in / take over.
      let liveUrl = "";
      try {
        const dbg = await bbFetch(`/sessions/${sid}/debug`, apiKey);
        liveUrl = (dbg && (dbg.debuggerFullscreenUrl || dbg.debuggerUrl)) || "";
      } catch { /* live view is best-effort */ }
      mountLiveView(liveUrl);

      // 4) Go to the starting page.
      if (startUrl && startUrl !== "about:blank") {
        try { await cdp.send("Page.navigate", { url: startUrl }); await waitReady(cdp); } catch { /* ignore */ }
      }

      async function evaluate(expression) {
        const r = await cdp.send("Runtime.evaluate", {
          expression, returnByValue: true, awaitPromise: true,
        });
        if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text || "Page script error");
        return r && r.result ? r.result.value : undefined;
      }

      async function waitReady(c, ms = 6000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          try {
            const r = await c.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
            if (r && r.result && r.result.value === "complete") return;
          } catch { /* ignore */ }
          await sleep(250);
        }
      }

      // Answer the same messages the on-page executor does.
      async function handle(message) {
        const type = message && message.type;
        if (type === "KINDRED_AUTOPILOT_OBSERVE") {
          return await evaluate(`(${kbObserve.toString()})()`);
        }
        if (type === "KINDRED_AUTOPILOT_ACT") {
          const a = message.action || {};
          if (a.type === "navigate") {
            try { await cdp.send("Page.navigate", { url: a.url }); await waitReady(cdp); return { ok: true }; }
            catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          }
          return await evaluate(`(${kbAct.toString()})(${JSON.stringify(a)})`);
        }
        // STATUS is shown via the Live View + the run log, so these are no-ops.
        return { ok: true };
      }

      async function stop() {
        try { unmountLiveView(); } catch { /* ignore */ }
        try { ws && ws.close(); } catch { /* ignore */ }
        try {
          await bbFetch(`/sessions/${sid}`, apiKey, { method: "POST", body: { projectId: proj, status: "REQUEST_RELEASE" } });
        } catch { /* ignore — sessions also time out on their own */ }
      }

      onLog(`Cloud session ready (${sid}).`);
      return { handle, stop, sessionId: sid };
    } catch (err) {
      try { unmountLiveView(); } catch { /* ignore */ }
      try { ws && ws.close(); } catch { /* ignore */ }
      throw err;
    }
  }

  window.KindredAutopilotCloud = { create };
})();