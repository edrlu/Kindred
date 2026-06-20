/* =========================================================
   Kindred — Side Panel
   Wires every control to a real action. Page reading and
   modification run in the active tab via chrome.scripting;
   every AI feature goes through window.KindredAI (OpenAI).
   Falls back to a demo context when run outside the
   extension (e.g. a plain browser preview) so the UI still
   responds.
   ========================================================= */

(() => {
  "use strict";

  const AI = window.KindredAI;
  const EXT =
    typeof chrome !== "undefined" &&
    chrome.scripting &&
    chrome.tabs &&
    chrome.scripting.executeScript;

  /* ---------------------------------------------------------
     Small DOM helpers
  --------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const statusEl = document.querySelector(".status");
  const statusDot = document.querySelector(".status__dot");
  const toastEl = $("toast");

  let toastTimer = null;
  function toast(message, type = "info") {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = `toast toast--${type} show`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => (toastEl.hidden = true), 250);
    }, 3200);
  }

  function setStatus(state) {
    // state: "ready" | "working" | "error"
    if (!statusEl) return;
    const label = statusEl.lastChild; // text node after the dot
    statusEl.dataset.state = state;
    const text =
      state === "working" ? "Working…" : state === "error" ? "Error" : "Ready";
    if (label && label.nodeType === Node.TEXT_NODE) label.textContent = " " + text;
    statusEl.title = text;
    if (statusDot) statusDot.dataset.state = state;
  }

  /* ---------------------------------------------------------
     Active-tab bridge (read / modify the real page)
  --------------------------------------------------------- */
  const RESTRICTED = /^(chrome|edge|brave|about|view-source|chrome-extension|moz-extension):|^https:\/\/chrome\.google\.com\/webstore/i;

  async function getActiveTab() {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  async function runOnPage(func, args = [], opts = {}) {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) throw new Error("No active tab to work on.");
    if (RESTRICTED.test(tab.url || "")) {
      throw new Error("Kindred can't run on this kind of page.");
    }
    const inject = { target: { tabId: tab.id }, func, args };
    if (opts.world) inject.world = opts.world; // "MAIN" to reach the page's own JS
    const [res] = await chrome.scripting.executeScript(inject);
    return res ? res.result : undefined;
  }

  async function setZoom(factor) {
    const tab = await getActiveTab();
    if (tab && tab.id != null) {
      try { await chrome.tabs.setZoom(tab.id, factor); } catch { /* ignore */ }
    }
  }

  /* ----- injected: read page context ----- */
  function kindredReadPage() {
    const pick = (sel) => Array.from(document.querySelectorAll(sel));
    const body = document.body ? document.body.innerText : "";
    const text = body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 12000);
    const meta = (document.querySelector('meta[name="description"]') || {}).content || "";
    const headings = pick("h1,h2,h3").map((h) => h.innerText.trim()).filter(Boolean).slice(0, 25);
    const links = pick("a[href], button")
      .map((a) => ({ t: (a.innerText || a.value || "").trim().slice(0, 70), h: a.href || "" }))
      .filter((x) => x.t)
      .slice(0, 60);

    // Detect repeated element groups (product cards, list items, table rows).
    // These give the AI accurate selectors to hook into for tables/extraction.
    const counts = Object.create(null);
    const els = document.body ? document.body.getElementsByTagName("*") : [];
    const limit = Math.min(els.length, 6000);
    for (let i = 0; i < limit; i++) {
      const el = els[i];
      const tag = el.tagName.toLowerCase();
      if (!/^(div|li|tr|article|section|td)$/.test(tag)) continue;
      const dct = el.getAttribute("data-component-type");
      const dt = el.getAttribute("data-testid");
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
      let key;
      if (dct) key = `${tag}[data-component-type="${dct}"]`;
      else if (dt) key = `${tag}[data-testid="${dt}"]`;
      else if (cls) key = `${tag}.${cls}`;
      else continue;
      counts[key] = (counts[key] || 0) + 1;
    }
    const sorted = Object.keys(counts)
      .filter((k) => counts[k] >= 4)
      .sort((a, b) => counts[b] - counts[a]);
    const structure = sorted.slice(0, 12).map((k) => `${k} ×${counts[k]}`);

    // Grab the real HTML of a few items from the largest repeated group so the
    // AI can choose exact selectors (title, price, link) instead of guessing.
    const samples = [];
    if (sorted.length) {
      try {
        const matches = document.querySelectorAll(sorted[0]);
        for (let i = 0; i < Math.min(matches.length, 3); i++) {
          const clone = matches[i].cloneNode(true);
          clone.querySelectorAll("script,style,svg,noscript,path").forEach((n) => n.remove());
          samples.push((clone.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 2000));
        }
      } catch { /* ignore */ }
    }

    return { url: location.href, title: document.title, meta, headings, links, structure, samples, text };
  }

  /* ----- injected: apply adaptation state via one <style> tag ----- */
  function kindredApply(state) {
    const ID = "kindred-style";
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement("style");
      el.id = ID;
      document.documentElement.appendChild(el);
    }
    const root = document.documentElement;
    root.classList.toggle("kindred-contrast", !!state.highContrast);
    root.classList.toggle("kindred-read", !!state.reading);

    let css = "";
    if (state.highContrast) {
      css += "html.kindred-contrast{filter:contrast(1.22) saturate(1.06) !important;}";
    }
    if (state.reading) {
      css +=
        "html.kindred-read p,html.kindred-read li,html.kindred-read article{line-height:1.85 !important;letter-spacing:.01em !important;}" +
        "html.kindred-read p,html.kindred-read li{max-width:72ch !important;}";
    }
    if (state.hideAds) {
      css +=
        ['[class*="advert" i]', '[id*="advert" i]', "ins.adsbygoogle", "[data-ad]",
          "[data-ad-slot]", '[aria-label*="advert" i]', ".ad", ".ads", ".ad-banner",
          '[class*="-ads-" i]', '[class*="sponsored" i]',
          'iframe[src*="doubleclick" i]', 'iframe[src*="googlesyndication" i]',
        ].join(",") + "{display:none !important;}";
    }
    if (Array.isArray(state.hideSelectors) && state.hideSelectors.length) {
      try {
        css += state.hideSelectors.join(",") + "{display:none !important;}";
      } catch { /* ignore bad selectors */ }
    }
    if (state.customCss) css += state.customCss;
    el.textContent = css;
    return true;
  }

  /* ----- injected: highlight an element on the page ----- */
  function kindredHighlight(selector) {
    document.querySelectorAll(".kindred-hl").forEach((e) => e.classList.remove("kindred-hl"));
    let el = null;
    try { el = selector ? document.querySelector(selector) : null; } catch { el = null; }
    if (!el) return false;
    if (!document.getElementById("kindred-hl-style")) {
      const s = document.createElement("style");
      s.id = "kindred-hl-style";
      s.textContent =
        ".kindred-hl{outline:3px solid #8a7d63 !important;outline-offset:3px !important;border-radius:6px !important;scroll-margin:90px !important;transition:outline-color .2s;}";
      document.documentElement.appendChild(s);
    }
    el.classList.add("kindred-hl");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  /* ----- injected (MAIN world): run AI-authored JS in the page ----- */
  function kindredRunJS(code) {
    try {
      // eslint-disable-next-line no-eval
      (0, eval)(code);
      return { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e);
      // ONLY fall back to a <script> tag when the page's CSP blocked eval.
      // For genuine bugs in the code, surface the real error instead of
      // silently re-running it (which used to mask failures).
      const cspBlocked =
        (e && e.name === "EvalError") ||
        /unsafe-eval|content security policy|call to eval/i.test(msg);
      if (cspBlocked) {
        try {
          const s = document.createElement("script");
          s.textContent = code;
          (document.head || document.documentElement).appendChild(s);
          s.remove();
          return { ok: true, via: "script" };
        } catch (e2) {
          return { ok: false, error: String((e2 && e2.message) || e2) };
        }
      }
      return { ok: false, error: msg };
    }
  }

  /* ----- injected (isolated world): Kindred's own extraction engine -----
     Trusted, deterministic. The AI supplies a `spec` (item selector +
     columns); this builds a clean, sortable, filterable, exportable table
     overlay with strong per-field heuristic fallbacks so rows fill even when
     the AI's selectors are imperfect. Runs as our own code (no eval), so page
     CSP never blocks it. Returns row count + per-column fill stats. */
  function kindredExtract(spec) {
    try {
      spec = spec || {};
      var abs = function (h) { try { return new URL(h, location.href).href; } catch (e) { return h || ""; } };

      function valueFrom(el, col) {
        if (!el) return "";
        var attr = col && col.attr;
        if (!attr || attr === "text") return (el.innerText || el.textContent || "").trim();
        if (attr === "href") return abs(el.getAttribute("href") || el.href || "");
        if (attr === "src") return el.getAttribute("src") || el.currentSrc || el.src || "";
        if (attr.charAt(0) === "@") return (el.getAttribute(attr.slice(1)) || "").trim();
        return (el.innerText || "").trim();
      }
      function firstMatch(item, selector, col) {
        if (!selector) return "";
        var parts = selector.split(",");
        for (var i = 0; i < parts.length; i++) {
          var s = parts[i].trim();
          if (!s) continue;
          try { var el = item.querySelector(s); if (el) { var v = valueFrom(el, col); if (v) return v; } } catch (e) {}
        }
        return "";
      }
      function bestTitle(item) {
        var c = [];
        item.querySelectorAll("h1,h2,h3,h4").forEach(function (h) { var t = (h.innerText || "").trim(); if (t) c.push(t); });
        item.querySelectorAll("a[href]").forEach(function (a) {
          var t = (a.innerText || a.getAttribute("aria-label") || a.title || "").trim(); if (t) c.push(t);
        });
        var img = item.querySelector("img[alt]"); if (img && img.alt) c.push(img.alt.trim());
        c = c.filter(function (t) { return t.length >= 4 && !/^[\s$£€¥]*[\d.,]+\s*$/.test(t); });
        c.sort(function (a, b) { return b.length - a.length; });
        return c[0] || "";
      }
      function priceIn(t) { var m = (t || "").match(/[$£€¥]\s?\d[\d.,]*/); return m ? m[0].replace(/\s/g, "") : ""; }
      function ratingIn(item) {
        var m = (item.innerText || "").match(/([0-5](?:\.\d)?)\s*(?:out of 5|stars?|\/\s*5)/i);
        if (m) return m[1];
        var al = item.querySelector('[aria-label*="out of 5" i],[aria-label*="stars" i]');
        if (al) { var mm = (al.getAttribute("aria-label") || "").match(/([0-5](?:\.\d)?)/); if (mm) return mm[1]; }
        return "";
      }
      function reviewsIn(item) { var m = (item.innerText || "").match(/\(([\d.,]+\s?[KMkm]?)\)/); return m ? m[1] : ""; }
      function linkIn(item) { var a = item.querySelector("a[href]"); return a ? abs(a.getAttribute("href")) : ""; }
      function imageIn(item) { var i = item.querySelector("img[src],img[srcset]"); return i ? (i.currentSrc || i.getAttribute("src") || "") : ""; }
      function heuristic(item, col) {
        switch (col.type) {
          case "title": return bestTitle(item);
          case "price": return priceIn(item.innerText);
          case "rating": return ratingIn(item);
          case "number": case "reviews": return reviewsIn(item);
          case "link": return linkIn(item);
          case "image": return imageIn(item);
          default: return "";
        }
      }
      function clean(v, col) {
        if (!v) return "";
        if (col.type === "price") { return priceIn(v) || v.trim(); }
        if (col.type === "rating") { var m = v.match(/([0-5](?:\.\d)?)/); return m ? m[1] : v.trim(); }
        if (col.type === "link") return abs(v);
        return v.replace(/\s+/g, " ").trim();
      }
      function field(item, col) { var v = firstMatch(item, col.selector, col); if (!v) v = heuristic(item, col); return clean(v, col); }

      function autoItems() {
        var groups = {}, all = document.body.getElementsByTagName("*"), lim = Math.min(all.length, 8000);
        for (var i = 0; i < lim; i++) {
          var el = all[i], p = el.parentElement; if (!p) continue;
          var cls = (typeof el.className === "string" && el.className.trim()) ? el.className.trim().split(/\s+/)[0] : "";
          var key = p.tagName + ">" + el.tagName + "." + cls;
          (groups[key] = groups[key] || []).push(el);
        }
        var best = [];
        Object.keys(groups).forEach(function (k) {
          var arr = groups[k]; if (arr.length < 3) return;
          var ok = arr.filter(function (e) { return e.querySelector("a") && (e.innerText || "").trim().length > 10; });
          if (ok.length >= 3 && ok.length > best.length) best = ok;
        });
        return best;
      }

      var items = [];
      if (spec.itemSelector) { try { items = Array.prototype.slice.call(document.querySelectorAll(spec.itemSelector)); } catch (e) {} }
      items = items.filter(function (it) { return (it.innerText || "").trim().length > 5; });
      if (items.length < 3) items = autoItems();
      if (!items.length) return { ok: false, reason: "no-items" };

      var columns = (spec.columns && spec.columns.length) ? spec.columns : [
        { name: "Title", type: "title" }, { name: "Price", type: "price" },
        { name: "Rating", type: "rating" }, { name: "Reviews", type: "number" }, { name: "Link", type: "link" }
      ];
      var rows = items.map(function (item) { return columns.map(function (col) { return field(item, col); }); });

      var stats = {};
      columns.forEach(function (c, ci) {
        var filled = rows.filter(function (r) { return r[ci] && String(r[ci]).trim(); }).length;
        stats[c.name] = rows.length ? Math.round((100 * filled) / rows.length) : 0;
      });

      renderSheet(spec.title || document.title || "Extracted data", columns, rows);
      return { ok: true, count: rows.length, stats: stats };

      function renderSheet(title, cols, data) {
        var old = document.getElementById("kindred-sheet"); if (old) old.remove();
        if (!document.getElementById("kindred-sheet-style")) {
          var st = document.createElement("style"); st.id = "kindred-sheet-style";
          st.textContent = [
            "#kindred-sheet{position:fixed;inset:0;z-index:2147483647;background:#fbfbfa;color:#1a1a18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;display:flex;flex-direction:column;}",
            "#kindred-sheet *{box-sizing:border-box;}",
            "#kindred-sheet .kx-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:14px 18px;border-bottom:1px solid #ececea;background:#fff;flex:0 0 auto;}",
            "#kindred-sheet .kx-title{font-size:15px;font-weight:650;letter-spacing:-.01em;}",
            "#kindred-sheet .kx-count{font-size:12px;color:#8a877f;}",
            "#kindred-sheet .kx-spacer{flex:1 1 12px;}",
            "#kindred-sheet .kx-search{font:inherit;font-size:13px;padding:7px 11px;border:1px solid #e2e2df;border-radius:9px;flex:1 1 130px;min-width:110px;max-width:260px;outline:none;}",
            "#kindred-sheet .kx-search:focus{border-color:#8a7d63;box-shadow:0 0 0 3px rgba(138,125,99,.15);}",
            "#kindred-sheet .kx-btn{font:inherit;font-size:12.5px;font-weight:550;padding:7px 13px;border:1px solid #e2e2df;border-radius:9px;background:#fff;cursor:pointer;}",
            "#kindred-sheet .kx-btn:hover{background:#f3f2f0;}",
            "#kindred-sheet .kx-btn--dark{background:#1c1b19;color:#fff;border-color:#1c1b19;}",
            "#kindred-sheet .kx-scroll{flex:1;overflow:auto;}",
            "#kindred-sheet table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;}",
            "#kindred-sheet thead th{position:sticky;top:0;background:#f5f4f1;text-align:left;font-weight:600;padding:11px 14px;border-bottom:1px solid #e2e2df;cursor:pointer;white-space:nowrap;user-select:none;}",
            "#kindred-sheet thead th:hover{background:#eeece8;}",
            "#kindred-sheet th .kx-ar{color:#b3b0a8;font-size:10px;margin-left:5px;}",
            "#kindred-sheet tbody td{padding:10px 14px;border-bottom:1px solid #f0efec;vertical-align:top;}",
            "#kindred-sheet tbody tr:nth-child(even){background:#fafaf8;}",
            "#kindred-sheet tbody tr:hover{background:#f1efe9;}",
            "#kindred-sheet td.kx-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}",
            "#kindred-sheet td.kx-title{max-width:440px;font-weight:500;}",
            "#kindred-sheet a.kx-link{color:#3a5ad0;text-decoration:none;}",
            "#kindred-sheet a.kx-link:hover{text-decoration:underline;}"
          ].join("");
          document.documentElement.appendChild(st);
        }
        var sheet = document.createElement("div"); sheet.id = "kindred-sheet";
        var bar = document.createElement("div"); bar.className = "kx-bar";
        bar.innerHTML = '<span class="kx-title"></span><span class="kx-count"></span><span class="kx-spacer"></span><input class="kx-search" placeholder="Filter…"><button class="kx-btn kx-csv">Export CSV</button><button class="kx-btn kx-btn--dark kx-close">Close</button>';
        bar.querySelector(".kx-title").textContent = title;
        bar.querySelector(".kx-count").textContent = data.length + " items";
        sheet.appendChild(bar);
        var scroll = document.createElement("div"); scroll.className = "kx-scroll";
        var table = document.createElement("table"), thead = document.createElement("thead"), htr = document.createElement("tr");
        cols.forEach(function (c, ci) {
          var th = document.createElement("th"); th.textContent = c.name;
          var ar = document.createElement("span"); ar.className = "kx-ar"; ar.textContent = "⇅"; th.appendChild(ar);
          th.addEventListener("click", function () { sortBy(ci, c); });
          htr.appendChild(th);
        });
        thead.appendChild(htr); table.appendChild(thead);
        var tbody = document.createElement("tbody"); table.appendChild(tbody);
        scroll.appendChild(table); sheet.appendChild(scroll);
        document.documentElement.appendChild(sheet);

        var sort = { col: -1, dir: 1 };
        function draw(list) {
          tbody.innerHTML = "";
          list.forEach(function (row) {
            var tr = document.createElement("tr");
            cols.forEach(function (c, ci) {
              var td = document.createElement("td"), val = row[ci] || "";
              if (c.type === "link" && val) { var a = document.createElement("a"); a.className = "kx-link"; a.href = val; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open"; td.appendChild(a); }
              else if (c.type === "image" && val) { var im = document.createElement("img"); im.src = val; im.style.cssText = "width:46px;height:46px;object-fit:contain;"; td.appendChild(im); }
              else if (/price|number|rating|reviews/.test(c.type || "")) { td.className = "kx-num"; td.textContent = val; }
              else if (c.type === "title") { td.className = "kx-title"; td.textContent = val; }
              else td.textContent = val;
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
        }
        draw(data);
        function numVal(s) { var m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; }
        function sortBy(ci, col) {
          sort.dir = sort.col === ci ? -sort.dir : 1; sort.col = ci;
          var numeric = /price|number|rating|reviews/.test(col.type || "");
          draw(data.slice().sort(function (a, b) {
            var x = a[ci] || "", y = b[ci] || "";
            if (numeric) { var nx = numVal(x), ny = numVal(y); if (isNaN(nx)) return 1; if (isNaN(ny)) return -1; return (nx - ny) * sort.dir; }
            return String(x).localeCompare(String(y)) * sort.dir;
          }));
        }
        bar.querySelector(".kx-search").addEventListener("input", function (e) {
          var q = e.target.value.toLowerCase();
          draw(q ? data.filter(function (r) { return r.join(" ").toLowerCase().indexOf(q) >= 0; }) : data);
        });
        bar.querySelector(".kx-close").addEventListener("click", function () { sheet.remove(); });
        bar.querySelector(".kx-csv").addEventListener("click", function () {
          var csv = [cols.map(function (c) { return c.name; })].concat(data).map(function (r) {
            return r.map(function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }).join(",");
          }).join("\n");
          var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
          a.download = (title || "data").replace(/[^\w]+/g, "_").slice(0, 40) + ".csv"; a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        });
      }
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  /* ---------------------------------------------------------
     Page context (cached) + demo fallback
  --------------------------------------------------------- */
  const DEMO_CTX = {
    url: "https://example.com/account/settings",
    title: "Account settings",
    meta: "Manage your email, password and notifications.",
    headings: ["Account settings", "Email", "Password", "Notifications", "Billing"],
    links: [
      { t: "Cancel plan", h: "https://example.com/billing/cancel" },
      { t: "Save changes", h: "https://example.com/account/save" },
    ],
    text:
      "Account settings. Update your email, password, and notification preferences. " +
      "Your plan renews automatically each month. To cancel, open Billing and choose Cancel plan. " +
      "Most changes save automatically.",
  };

  let pageCtx = null;
  async function readPage(force = false) {
    if (pageCtx && !force) return pageCtx;
    if (!EXT) {
      pageCtx = DEMO_CTX;
      return pageCtx;
    }
    pageCtx = await runOnPage(kindredReadPage);
    return pageCtx;
  }

  function prettyUrl(u) {
    try {
      const { hostname, pathname } = new URL(u);
      return (hostname + pathname).replace(/\/$/, "");
    } catch {
      return u;
    }
  }

  /* ---------------------------------------------------------
     Adaptation state
  --------------------------------------------------------- */
  const adaptState = {
    largerText: false,
    highContrast: false,
    hideAds: false,
    reading: false,
    hideSelectors: [],
    customCss: "",
  };

  // JS snippets, extraction specs + commands applied this session
  // (captured when saving a site so they reapply on revisit).
  let appliedJs = [];
  let appliedExtracts = [];
  let lastCommands = [];

  /* ---------------------------------------------------------
     Per-domain saved views (chrome.storage, localStorage fallback)
  --------------------------------------------------------- */
  const SITES_KEY = "kindred.sites";
  const hasChromeStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  async function getSites() {
    if (hasChromeStorage) {
      return new Promise((res) =>
        chrome.storage.local.get(SITES_KEY, (r) => res(r[SITES_KEY] || {}))
      );
    }
    try { return JSON.parse(localStorage.getItem(SITES_KEY) || "{}"); } catch { return {}; }
  }
  async function setSites(obj) {
    if (hasChromeStorage) {
      return new Promise((res) => chrome.storage.local.set({ [SITES_KEY]: obj }, res));
    }
    localStorage.setItem(SITES_KEY, JSON.stringify(obj));
  }
  async function getSite(host) {
    if (!host) return null;
    return (await getSites())[host] || null;
  }
  async function saveSite(host, recipe) {
    const all = await getSites();
    all[host] = recipe;
    await setSites(all);
  }
  async function removeSite(host) {
    const all = await getSites();
    delete all[host];
    await setSites(all);
  }

  async function currentHost() {
    if (!EXT) {
      try { return new URL(DEMO_CTX.url).hostname; } catch { return "example.com"; }
    }
    const tab = await getActiveTab();
    try { return new URL(tab.url).hostname; } catch { return null; }
  }

  function syncAdaptUI() {
    document.querySelectorAll("[data-adapt]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(!!adaptState[btn.dataset.adapt]));
    });
    const readabilityTile = document.querySelector('[data-action="readability"]');
    if (readabilityTile) readabilityTile.setAttribute("aria-pressed", String(adaptState.reading));
  }

  async function applyAdaptations() {
    syncAdaptUI();
    if (!EXT) {
      toast("Adaptations apply to the active tab when running as the extension.", "info");
      return;
    }
    try {
      await setZoom(adaptState.largerText ? 1.2 : 1);
      await runOnPage(kindredApply, [
        {
          highContrast: adaptState.highContrast,
          reading: adaptState.reading,
          hideAds: adaptState.hideAds,
          hideSelectors: adaptState.hideSelectors,
          customCss: adaptState.customCss,
        },
      ]);
    } catch (e) {
      toast(e.message || "Couldn't reach the page.", "error");
    }
  }

  async function resetAdaptations() {
    adaptState.largerText = false;
    adaptState.highContrast = false;
    adaptState.hideAds = false;
    adaptState.reading = false;
    adaptState.hideSelectors = [];
    adaptState.customCss = "";
    appliedJs = [];
    appliedExtracts = [];
    lastCommands = [];
    if (EXT) {
      try { await runOnPage(() => { const s = document.getElementById("kindred-sheet"); if (s) s.remove(); }); } catch { /* ignore */ }
    }
    await applyAdaptations();
    toast("Reset this page. Reload to undo script changes.", "info");
  }

  function recipeHasContent(r) {
    const a = r.adaptations || {};
    return (
      a.largerText || a.highContrast || a.hideAds || a.reading ||
      (r.hideSelectors && r.hideSelectors.length) ||
      (r.customCss && r.customCss.trim()) ||
      (r.js && r.js.length)
    );
  }

  function currentRecipe() {
    return {
      adaptations: {
        largerText: adaptState.largerText,
        highContrast: adaptState.highContrast,
        hideAds: adaptState.hideAds,
        reading: adaptState.reading,
      },
      hideSelectors: adaptState.hideSelectors.slice(),
      customCss: adaptState.customCss,
      js: appliedJs.slice(),
      extracts: appliedExtracts.slice(),
      commands: lastCommands.slice(),
      savedAt: Date.now(),
    };
  }

  // Apply a stored recipe: styling first, then re-run its JS snippets.
  async function applyRecipe(recipe) {
    const a = recipe.adaptations || {};
    adaptState.largerText = !!a.largerText;
    adaptState.highContrast = !!a.highContrast;
    adaptState.hideAds = !!a.hideAds;
    adaptState.reading = !!a.reading;
    adaptState.hideSelectors = Array.isArray(recipe.hideSelectors) ? recipe.hideSelectors.slice() : [];
    adaptState.customCss = recipe.customCss || "";
    appliedJs = Array.isArray(recipe.js) ? recipe.js.slice() : [];
    appliedExtracts = Array.isArray(recipe.extracts) ? recipe.extracts.slice() : [];
    lastCommands = Array.isArray(recipe.commands) ? recipe.commands.slice() : [];
    await applyAdaptations();
    if (EXT) {
      for (const code of appliedJs) {
        if (code && code.trim()) {
          try { await runOnPage(kindredRunJS, [code], { world: "MAIN" }); } catch { /* ignore */ }
        }
      }
      for (const spec of appliedExtracts) {
        try { await runOnPage(kindredExtract, [spec]); } catch { /* ignore */ }
      }
    }
  }

  /* ----- saved-view banner ----- */
  const bannerEl = $("saved-banner");
  const bannerText = $("saved-banner-text");

  function showBanner(host) {
    if (!bannerEl) return;
    bannerText.innerHTML = `Saved view active on <strong>${escapeHtml(host)}</strong>`;
    bannerEl.hidden = false;
  }
  function hideBanner() {
    if (bannerEl) bannerEl.hidden = true;
  }

  async function saveCurrentForSite() {
    const host = await currentHost();
    if (!host) {
      toast("No site to save here.", "error");
      return;
    }
    const recipe = currentRecipe();
    if (!recipeHasContent(recipe)) {
      toast("Adapt the page first, then save it.", "info");
      return;
    }
    await saveSite(host, recipe);
    showBanner(host);
    toast(`Saved for ${host}. It'll reapply on your next visit.`, "ok");
  }

  async function removeCurrentSite() {
    const host = await currentHost();
    if (host) await removeSite(host);
    hideBanner();
    toast("Removed saved view. Reload the page to clear it.", "info");
  }

  /* ---------------------------------------------------------
     Busy guard
  --------------------------------------------------------- */
  let running = false;
  async function withBusy(el, fn) {
    if (running) return;
    running = true;
    setStatus("working");
    if (el) el.setAttribute("aria-busy", "true");
    try {
      await fn();
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      toast(e.message || "Something went wrong.", "error");
      setTimeout(() => setStatus("ready"), 2500);
    } finally {
      if (el) el.removeAttribute("aria-busy");
      running = false;
    }
  }

  async function ensureKey() {
    if (AI && (await AI.isConfigured())) return true;
    toast("Add your OpenAI API key in Settings first.", "error");
    openSettings();
    return false;
  }

  function ctxToPrompt(ctx) {
    const links = (ctx.links || [])
      .filter((l) => l.h)
      .slice(0, 25)
      .map((l) => `- "${l.t}" -> ${l.h}`)
      .join("\n");
    return (
      `Title: ${ctx.title}\nURL: ${ctx.url}\n` +
      (ctx.meta ? `Description: ${ctx.meta}\n` : "") +
      (ctx.headings?.length ? `Headings: ${ctx.headings.join(" | ")}\n` : "") +
      (ctx.structure?.length
        ? `Repeated elements on the page (reliable selectors for tables/lists):\n${ctx.structure.join("\n")}\n`
        : "") +
      (ctx.samples && ctx.samples.length
        ? `Sample repeated items — real HTML. Use these to pick the EXACT relative selectors for title, price, link, rating, etc.:\n` +
          ctx.samples.map((s, i) => `[item ${i + 1}] ${s}`).join("\n\n") + "\n"
        : "") +
      (links ? `Links & buttons:\n${links}\n` : "") +
      `\nVisible text:\n${ctx.text || ""}`
    );
  }

  async function modelFor(kind) {
    const cfg = AI ? await AI.getConfig() : {};
    if (kind === "generation") return cfg.generationModel || cfg.model || "gpt-5";
    return cfg.assistantModel || "gpt-5-mini";
  }

  /* ---------------------------------------------------------
     AI feature: Safety check
  --------------------------------------------------------- */
  const verdictEl = $("safety-verdict");
  const findingsEl = $("safety-findings");

  function renderSafety(data) {
    const verdictMap = {
      safe: { text: "Looks safe", cls: "verdict--ok" },
      caution: { text: "Be careful", cls: "verdict--warn" },
      risk: { text: "Risky", cls: "verdict--risk" },
    };
    const v = verdictMap[data.verdict] || verdictMap.caution;
    verdictEl.textContent = v.text;
    verdictEl.className = `verdict ${v.cls}`;
    verdictEl.hidden = false;

    const dotClass = { ok: "dot--ok", warn: "dot--warn", risk: "dot--risk" };
    const findings = Array.isArray(data.findings) ? data.findings : [];
    findingsEl.innerHTML =
      findings.map((f) =>
        `<li class="finding"><span class="dot ${dotClass[f.level] || "dot--warn"}" aria-hidden="true"></span><span>${escapeHtml(f.text)}</span></li>`
      ).join("") ||
      '<li class="finding finding--empty"><span class="dot dot--ok"></span><span>No scam signals found on this page.</span></li>';
  }

  async function runSafety() {
    if (!(await ensureKey())) return;
    verdictEl.hidden = true;
    findingsEl.innerHTML =
      '<li class="finding finding--empty"><span class="dot dot--ok"></span><span>Scanning this page…</span></li>';
    const ctx = await readPage(true);
    const data = await AI.completeJSON([
      {
        role: "system",
        content:
          'You analyze web pages for risks to a vulnerable or elderly user: scams, phishing, dark patterns, hidden costs, auto-renewals, hard-to-find cancellation, fake urgency, and requests for sensitive information. Respond ONLY as JSON: {"verdict":"safe|caution|risk","findings":[{"level":"ok|warn|risk","text":"one short plain sentence"}]}. Give 2-4 findings, most important first.',
      },
      { role: "user", content: ctxToPrompt(ctx) },
    ], { model: await modelFor("assistant") });

    renderSafety(data);
  }

  /* ---------------------------------------------------------
     Simplify this page (curated preset)
  --------------------------------------------------------- */
  async function simplifyPage() {
    adaptState.largerText = true;
    adaptState.hideAds = true;
    adaptState.reading = true;
    adaptState.highContrast = false;
    await applyAdaptations();
    toast("Page simplified.", "ok");
  }

  /* ---------------------------------------------------------
     Composer: natural-language adaptation
  --------------------------------------------------------- */
  const input = $("adapt-input");
  const composerForm = document.querySelector(".composer__form");

  function autoGrow() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  function sanitizeCss(css) {
    if (typeof css !== "string") return "";
    return css.replace(/@import|javascript:|expression\s*\(|<\/?style/gi, "").slice(0, 4000);
  }

  async function runCommand() {
    const command = (input.value || "").trim();
    if (!command) return;
    if (!(await ensureKey())) return;
    input.value = "";
    autoGrow();
    const ctx = await readPage(true);
    const data = await AI.completeJSON([
      {
        role: "system",
        content:
          'You control Kindred, an accessibility layer over the current web page. The user describes how they want the page changed, and you make it happen. ' +
          'Respond ONLY as JSON with any of these keys: {"reply":"one short friendly sentence","adaptations":{"largerText":bool,"highContrast":bool,"hideAds":bool,"reading":bool},"hideSelectors":["css selector"],"css":"extra CSS rules","js":"JavaScript","extract":{...}}. ' +
          'Use "adaptations" (include ONLY keys the user wants changed), "hideSelectors", and "css" for styling, hiding, and layout. ' +
          'For ANY request to turn the page into a table / spreadsheet / list, to compare items, or to extract repeated data: use "extract" (NOT js). ' +
          'extract = {"title":"short title","itemSelector":"CSS selector matching EACH repeated item","columns":[{"name":"Title","type":"title","selector":"CSS selector relative to one item","attr":"text|href|src|@attrName"}]}. ' +
          'Column "type" is one of: title, price, rating, number, link, image, text. "selector" is evaluated inside each item; "attr" chooses what to read (default text; use "href" for links, "src" for images, "@name" for an attribute). ' +
          'Study the provided "Sample repeated items" HTML to pick precise selectors and the itemSelector (prefer one of the "Repeated elements" selectors). Always include a Title column (type "title"); add price, rating, reviews (type number), and a link column whenever that data exists. Kindred has strong fallbacks and fills any field you get wrong, so just give your best selectors — never worry about empty rows. ' +
          'Use "js" ONLY for other dynamic behaviour CSS cannot do (adding buttons, clicking, filling forms, expanding/collapsing, rearranging). It runs in the page context with full access to document/window; wrap it in an IIFE and make it idempotent. ' +
          'Do not submit payments, place orders, delete data, or navigate away unless the user explicitly asks. Omit any field you are not using.',
      },
      { role: "user", content: `${ctxToPrompt(ctx)}\n\nUser request: ${command}` },
    ], { model: await modelFor("generation") });

    const a = data.adaptations || {};
    ["largerText", "highContrast", "hideAds", "reading"].forEach((k) => {
      if (typeof a[k] === "boolean") adaptState[k] = a[k];
    });
    if (Array.isArray(data.hideSelectors)) {
      for (const sel of data.hideSelectors) {
        if (typeof sel === "string" && sel.trim() && !adaptState.hideSelectors.includes(sel.trim())) {
          adaptState.hideSelectors.push(sel.trim());
        }
      }
    }
    const css = sanitizeCss(data.css);
    if (css) adaptState.customCss += "\n" + css;

    await applyAdaptations();

    // Tabular extraction → Kindred's trusted engine (deterministic, no eval),
    // with one AI refine pass if the first result is thin.
    if (data.extract && (data.extract.columns || data.extract.itemSelector)) {
      if (!EXT) {
        toast("Tables build on the active tab in the extension.", "info");
        lastCommands.push(command);
        return;
      }
      let spec = data.extract;
      let res = await runOnPage(kindredExtract, [spec]);
      const titleCol = (spec.columns || []).find((c) => c.type === "title");
      const titleFill = res && res.ok && titleCol ? (res.stats[titleCol.name] ?? 0) : 100;
      if (!res || !res.ok || res.count < 3 || titleFill < 60) {
        try {
          const fix = await AI.completeJSON([
            {
              role: "system",
              content:
                'You are refining a Kindred data-extraction spec. Return ONLY JSON {"extract":{"title","itemSelector","columns":[{"name","type","selector","attr"}]}}. Types: title, price, rating, number, link, image, text. Study the sample item HTML and fix the itemSelector and column selectors so every row gets a Title and the key fields fill.',
            },
            {
              role: "user",
              content: `${ctxToPrompt(ctx)}\n\nUser request: ${command}\n\nPrevious spec:\n${JSON.stringify(spec)}\n\nResult: ${res ? res.count : 0} rows; column fill rates: ${JSON.stringify((res && res.stats) || {})}. Improve it.`,
            },
          ], { model: await modelFor("generation") });
          if (fix.extract && (fix.extract.columns || fix.extract.itemSelector)) {
            const res2 = await runOnPage(kindredExtract, [fix.extract]);
            if (res2 && res2.ok && res2.count >= (res ? res.count : 0)) { res = res2; spec = fix.extract; }
          }
        } catch (e) { /* keep first result */ }
      }
      if (res && res.ok) {
        appliedExtracts.push(spec);
        lastCommands.push(command);
        toast(`Spreadsheet ready — ${res.count} rows.`, "ok");
      } else {
        toast("Couldn't find a list of items to tabulate here.", "error");
      }
      return;
    }

    // Run any AI-authored JavaScript in the page itself.
    let jsOk = true;
    if (data.js && typeof data.js === "string" && data.js.trim()) {
      if (!EXT) {
        toast("Page scripts run on the active tab in the extension.", "info");
      } else {
        const result = await runOnPage(kindredRunJS, [data.js], { world: "MAIN" });
        if (result && result.ok === false) {
          jsOk = false;
          toast(`Couldn't apply that change: ${result.error}`, "error");
        }
      }
    }

    // Remember what we applied so "Save" can capture it for this site.
    if (jsOk && data.js && data.js.trim()) appliedJs.push(data.js);
    lastCommands.push(command);

    if (jsOk) toast(data.reply || "Done.", "ok");
  }

  /* ---------------------------------------------------------
     Settings panel
  --------------------------------------------------------- */
  const settings = $("settings");
  const openBtn = $("open-settings");
  const closeBtn = $("close-settings");
  const keyInput = $("api-key");
  const toggleKey = $("toggle-key");
  const generationModelSelect = $("generation-model");
  const assistantModelSelect = $("assistant-model");
  const scamAlert = $("scam-alert");
  const safetyLabel = $("safety-label");
  const saveBtn = $("save-settings");
  const saveStatus = $("save-status");

  async function openSettings() {
    if (AI) {
      const cfg = await AI.getConfig();
      if (cfg.apiKey) keyInput.value = cfg.apiKey;
      generationModelSelect.value = cfg.generationModel || cfg.model || "gpt-5";
      assistantModelSelect.value = cfg.assistantModel || "gpt-5-mini";
      scamAlert.checked = Boolean(cfg.scamAlert);

      // Sponsor-track keys (Anthropic / Deepgram / ElevenLabs / Browserbase / Resend)
      const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
      const setChk = (id, v) => { const el = $(id); if (el) el.checked = Boolean(v); };
      setVal("anthropic-key", cfg.anthropicKey);
      const am = $("agent-model"); if (am) am.value = cfg.agentModel || "claude-opus-4-8";
      setVal("deepgram-key", cfg.deepgramKey);
      setVal("elevenlabs-key", cfg.elevenLabsKey);
      setVal("voice-id", cfg.voiceId);
      setChk("voice-enabled", cfg.voiceEnabled);
      setVal("browserbase-key", cfg.browserbaseKey);
      setVal("browserbase-project", cfg.browserbaseProjectId);
      setVal("trusted-name", cfg.trustedName);
      setVal("trusted-email", cfg.trustedEmail);
      setVal("resend-key", cfg.resendKey);
      setVal("from-email", cfg.fromEmail);
    }
    settings.hidden = false;
    keyInput.focus();
  }
  function closeSettings() {
    settings.hidden = true;
  }

  function setScamAlertUI(enabled) {
    if (safetyLabel) safetyLabel.textContent = enabled ? "Scam alert" : "Safety check";
  }

  function renderAutomaticScan(scan) {
    if (scan?.state === "scanning") {
      verdictEl.hidden = true;
      findingsEl.innerHTML = '<li class="finding finding--empty"><span class="dot dot--ok"></span><span>Checking this page…</span></li>';
      setScamAlertUI(true);
      return;
    }
    renderSafety(scan || {});
    setScamAlertUI(true);
  }

  async function loadStoredScan(tabId) {
    if (!EXT || !Number.isInteger(tabId) || !chrome.storage?.session) return;
    const key = `kindred.scam-status.${tabId}`;
    const stored = await chrome.storage.session.get(key);
    if (stored[key]) renderAutomaticScan(stored[key]);
  }

  let panelRefreshInFlight = false;
  async function refreshForLivePageChange(tabId, page = {}) {
    if (panelRefreshInFlight) return;
    const active = await getActiveTab();
    if (!active || active.id !== tabId) return;
    panelRefreshInFlight = true;
    try {
      pageCtx = null;
      const ctx = await readPage(true);
      const urlEl = $("context-url");
      if (urlEl) urlEl.textContent = prettyUrl(ctx.url || page.url || active.url || "");
      const cfg = AI ? await AI.getConfig() : {};
      if (cfg.scamAlert) {
        renderAutomaticScan({ state: "scanning", matches: [] });
      }
    } catch {
      // A page can be between navigation states; the next page activity event retries.
    } finally {
      panelRefreshInFlight = false;
    }
  }

  /* ---------------------------------------------------------
     Wire everything up
  --------------------------------------------------------- */

  // Primary
  $("simplify").addEventListener("click", (e) => withBusy(e.currentTarget, simplifyPage));

  // A previously saved view can still be removed from its banner.
  const removeSiteBtn = $("remove-site");
  if (removeSiteBtn) {
    removeSiteBtn.addEventListener("click", () =>
      removeCurrentSite().catch((e) => toast(e.message || "Couldn't remove.", "error"))
    );
  }

  // Quick-action tiles
  const actions = {
    safety: (el) => withBusy(el, runSafety),
    readability: (el) => {
      adaptState.reading = !adaptState.reading;
      withBusy(el, applyAdaptations);
    },
    readaloud: (el) => withBusy(el, readAloud),
    notify: (el) => withBusy(el, tellContact),
  };
  document.querySelectorAll("[data-action]").forEach((tile) => {
    tile.addEventListener("click", () => actions[tile.dataset.action]?.(tile));
  });

  // Composer
  if (input) {
    input.addEventListener("input", autoGrow);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        withBusy(null, runCommand);
      }
    });
  }
  if (composerForm) {
    composerForm.addEventListener("submit", (e) => {
      e.preventDefault();
      withBusy(null, runCommand);
    });
  }

  // Settings
  if (openBtn) openBtn.addEventListener("click", openSettings);
  if (closeBtn) closeBtn.addEventListener("click", closeSettings);
  if (toggleKey && keyInput) {
    toggleKey.addEventListener("click", () => {
      const show = keyInput.type === "password";
      keyInput.type = show ? "text" : "password";
      toggleKey.setAttribute("aria-label", show ? "Hide key" : "Show key");
    });
  }
  if (scamAlert) {
    scamAlert.addEventListener("change", async () => {
      if (!AI) return;
      await AI.setConfig({ scamAlert: scamAlert.checked });
      setScamAlertUI(scamAlert.checked);
      if (scamAlert.checked) renderAutomaticScan({ state: "scanning", matches: [] });
      toast(scamAlert.checked ? "Scam alert is now on and saved." : "Scam alert is now off and saved.", "info");
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      if (!AI) return;
      const val = (id) => { const el = $(id); return el ? el.value.trim() : ""; };
      const chk = (id) => { const el = $(id); return el ? el.checked : false; };
      await AI.setConfig({
        apiKey: keyInput.value.trim(),
        generationModel: generationModelSelect.value,
        assistantModel: assistantModelSelect.value,
        scamAlert: scamAlert.checked,
        // Sponsor-track keys
        anthropicKey: val("anthropic-key"),
        agentModel: ($("agent-model") && $("agent-model").value) || "claude-opus-4-8",
        deepgramKey: val("deepgram-key"),
        elevenLabsKey: val("elevenlabs-key"),
        voiceId: val("voice-id"),
        voiceEnabled: chk("voice-enabled"),
        browserbaseKey: val("browserbase-key"),
        browserbaseProjectId: val("browserbase-project"),
        trustedName: val("trusted-name"),
        trustedEmail: val("trusted-email"),
        resendKey: val("resend-key"),
        fromEmail: val("from-email"),
      });
      if (EXT) {
        const tab = await getActiveTab();
        if (tab?.id != null) {
          chrome.tabs.sendMessage(tab.id, { type: "KINDRED_SCAM_ALERT", enabled: scamAlert.checked }).catch(() => {});
        }
      }
      saveStatus.textContent = "Saved";
      saveStatus.classList.add("show");
      setTimeout(() => saveStatus.classList.remove("show"), 1800);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settings && !settings.hidden) closeSettings();
  });

  if (EXT && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(async (message) => {
      if (message?.type === "KINDRED_PAGE_ACTIVITY") {
        await refreshForLivePageChange(message.tabId, message.page);
        return;
      }
      if (message?.type !== "KINDRED_SCAM_STATUS") return;
      const tab = await getActiveTab();
      if (tab?.id !== message.tabId) return;
      renderAutomaticScan(message.scan || {});
    });
  }
  if (EXT && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "session") return;
      const tab = await getActiveTab();
      const key = tab?.id == null ? "" : `kindred.scam-status.${tab.id}`;
      if (key && changes[key]?.newValue) renderAutomaticScan(changes[key].newValue);
    });
  }

  // Re-apply a saved view whenever the active tab finishes loading
  // (covers reloads and new searches on the same domain).
  if (EXT && chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
      if (info.status !== "complete" || !tab || !tab.active) return;
      let host = null;
      try { host = new URL(tab.url).hostname; } catch { /* ignore */ }
      const urlEl = $("context-url");
      if (urlEl && tab.url) urlEl.textContent = prettyUrl(tab.url);
      if (!host) return;
      const recipe = await getSite(host);
      if (recipe) {
        pageCtx = null; // force a fresh read
        try { await applyRecipe(recipe); showBanner(host); } catch { /* ignore */ }
      } else {
        hideBanner();
      }
    });
  }
  if (EXT && chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(({ tabId }) => {
      refreshForLivePageChange(tabId);
    });
  }

  /* ---------------------------------------------------------
     Voice input (Deepgram → text, with browser fallback)
  --------------------------------------------------------- */
  const Voice = window.KindredVoice;
  const Agent = window.KindredAgent;
  const Providers = window.KindredProviders;
  const Notify = window.KindredNotify;

  let activeListen = null; // { controllerP, button, target, base }

  function stopVoiceInput() {
    if (!activeListen) return;
    const a = activeListen;
    activeListen = null;
    a.button.classList.remove("is-listening");
    a.controllerP.then((c) => { try { c && c.stop && c.stop(); } catch { /* ignore */ } }).catch(() => {});
  }

  async function toggleVoiceInput(button, target) {
    if (activeListen) { stopVoiceInput(); return; }
    if (!Voice) { toast("Voice input isn't available here.", "error"); return; }
    let caps;
    try { caps = await Voice.capabilities(); } catch { caps = { stt: false }; }
    if (!caps.stt) {
      toast("Add a Deepgram key in Settings to speak (or use Chrome).", "error");
      return;
    }
    button.classList.add("is-listening");
    const base = target.value ? target.value.trim() + " " : "";
    const put = (t) => {
      target.value = base + t;
      if (target.tagName === "TEXTAREA") autoGrow();
    };
    const controllerP = Voice.listen({
      onPartial: put,
      onFinal: (t) => { put(t); stopVoiceInput(); },
      onError: (e) => { toast((e && e.message) || "Voice error.", "error"); stopVoiceInput(); },
    });
    activeListen = { controllerP, button, target, base };
  }

  /* ---------------------------------------------------------
     Read the page aloud (ElevenLabs, with browser fallback)
  --------------------------------------------------------- */
  let reading = false;
  async function readAloud() {
    if (!Voice) { toast("Voice isn't available here.", "error"); return; }
    if (reading) { Voice.stopSpeaking(); reading = false; toast("Stopped reading.", "info"); return; }
    const ctx = await readPage(true).catch(() => ({}));
    const text = ((ctx.title ? ctx.title + ". " : "") + (ctx.text || "")).slice(0, 4000).trim();
    if (!text) { toast("There's nothing to read on this page.", "info"); return; }
    reading = true;
    toast("Reading this page aloud…", "info");
    try { await Voice.speak(text); } catch (e) { toast((e && e.message) || "Couldn't read aloud.", "error"); }
    reading = false;
  }

  /* ---------------------------------------------------------
     Tell my trusted contact (one designated address)
  --------------------------------------------------------- */
  async function tellContact() {
    if (!Notify) { toast("Alerts aren't available here.", "error"); return; }
    if (!(await Notify.isConfigured())) {
      toast("Add a Resend key and a trusted contact email in Settings.", "error");
      openSettings();
      return;
    }
    const ctx = await readPage(true).catch(() => ({}));
    const res = await Notify.sendAlert({
      subject: "A note from Kindred on your family member's behalf",
      message:
        "I'm browsing a website and could use a little help. Kindred is sending you this note for me — when you have a moment, could you check in?",
      pageUrl: ctx.url,
      pageTitle: ctx.title,
    });
    if (res.ok) toast("Sent a note to your trusted contact.", "ok");
    else toast(res.skipped || res.error || "Couldn't send the note.", res.skipped ? "info" : "error");
  }

  /* ---------------------------------------------------------
     Guide Me / Autopilot — run panel + orchestration
  --------------------------------------------------------- */
  const taskForm = $("task-form");
  const taskInput = $("task-input");
  const taskFormLabel = $("task-form-label");
  const runPanel = $("run-panel");
  const runTitle = $("run-title");
  const runLog = $("run-log");
  const runStop = $("run-stop");
  const runConfirm = $("run-confirm");
  const runConfirmText = $("run-confirm-text");
  const runYes = $("run-yes");
  const runNo = $("run-no");
  const runNext = $("run-next");

  let currentMode = null;     // "guide" | "autopilot"
  let runFinished = false;
  let pendingConfirm = null;   // resolve(bool) for an Autopilot risky step
  let pendingNext = null;      // resolve() for a Guide "next" press

  async function ensureAnthropic() {
    if (Providers && (await Providers.hasAnthropic())) return true;
    toast("Add an Anthropic (Claude) API key in Settings to use this.", "error");
    openSettings();
    return false;
  }

  function showTaskForm(mode) {
    currentMode = mode;
    if (taskFormLabel) {
      taskFormLabel.textContent = mode === "guide"
        ? "What would you like help with?"
        : "What should I do for you?";
    }
    if (taskInput) {
      taskInput.placeholder = mode === "guide"
        ? "e.g. How do I buy this on Amazon?"
        : "e.g. Find the cheapest umbrella and add it to my cart";
      taskInput.value = (input && input.value ? input.value.trim() : "");
    }
    if (runPanel) runPanel.hidden = true;
    if (taskForm) taskForm.hidden = false;
    if (taskInput) taskInput.focus();
  }

  function logRun(msg, muted) {
    if (!runLog) return;
    const li = document.createElement("li");
    if (muted) li.className = "is-muted";
    li.textContent = msg;
    runLog.appendChild(li);
    runLog.scrollTop = runLog.scrollHeight;
  }

  function startRunPanel(title) {
    runFinished = false;
    pendingConfirm = null;
    pendingNext = null;
    if (runLog) runLog.innerHTML = "";
    if (runTitle) runTitle.textContent = title;
    if (runStop) runStop.textContent = "Stop";
    if (runConfirm) runConfirm.hidden = true;
    if (runNext) runNext.hidden = true;
    if (runPanel) runPanel.hidden = false;
  }

  function finishRun() {
    runFinished = true;
    pendingConfirm = null;
    pendingNext = null;
    if (runStop) runStop.textContent = "Close";
    if (runNext) runNext.hidden = true;
    if (runConfirm) runConfirm.hidden = true;
    Voice && Voice.stopSpeaking && Voice.stopSpeaking();
  }

  async function startTask() {
    const goal = (taskInput && taskInput.value ? taskInput.value.trim() : "");
    if (!goal) { taskInput && taskInput.focus(); return; }
    if (!(await ensureAnthropic())) return;
    if (taskForm) taskForm.hidden = true;
    if (currentMode === "guide") {
      startRunPanel("Guiding you…");
      logRun("Goal: " + goal, true);
      Agent.guide(goal, {
        onLog: (m) => logRun(m),
        onStep: () => { if (runNext) runNext.hidden = false; },
        onConfirmAdvance: () => new Promise((res) => { pendingNext = res; }),
        onDone: (m) => { logRun("✓ " + m); finishRun(); },
        onError: (e) => { logRun("⚠ " + ((e && e.message) || e), true); toast((e && e.message) || "Guide stopped.", "error"); finishRun(); },
      });
    } else {
      startRunPanel("Autopilot");
      logRun("Task: " + goal, true);
      Agent.autopilot(goal, {
        onLog: (m) => logRun(m),
        onConfirm: (say) => new Promise((res) => {
          pendingConfirm = res;
          if (runConfirmText) runConfirmText.textContent = say + " — is that OK?";
          if (runConfirm) runConfirm.hidden = false;
        }),
        onDone: (m) => { logRun("✓ " + m); finishRun(); },
        onError: (e) => { logRun("⚠ " + ((e && e.message) || e), true); toast((e && e.message) || "Autopilot stopped.", "error"); finishRun(); },
      });
    }
  }

  /* ----- feature + run-panel wiring ----- */
  const guideBtn = $("guide-me");
  const autopilotBtn = $("autopilot");
  if (guideBtn) guideBtn.addEventListener("click", () => showTaskForm("guide"));
  if (autopilotBtn) autopilotBtn.addEventListener("click", () => showTaskForm("autopilot"));

  const taskStart = $("task-start");
  const taskCancel = $("task-cancel");
  const taskMic = $("task-mic");
  if (taskStart) taskStart.addEventListener("click", startTask);
  if (taskCancel) taskCancel.addEventListener("click", () => { if (taskForm) taskForm.hidden = true; });
  if (taskInput) taskInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startTask(); } });
  if (taskMic && taskInput) taskMic.addEventListener("click", () => toggleVoiceInput(taskMic, taskInput));

  const composerMic = $("composer-mic");
  if (composerMic && input) composerMic.addEventListener("click", () => toggleVoiceInput(composerMic, input));

  if (runStop) {
    runStop.addEventListener("click", () => {
      if (runFinished) {
        if (runPanel) runPanel.hidden = true;
        Agent && Agent.clearOverlays && Agent.clearOverlays();
        return;
      }
      Agent && Agent.stop && Agent.stop();
      if (pendingConfirm) { pendingConfirm(false); pendingConfirm = null; }
      if (pendingNext) { pendingNext(); pendingNext = null; }
      logRun("Stopping…", true);
    });
  }
  if (runYes) runYes.addEventListener("click", () => {
    if (runConfirm) runConfirm.hidden = true;
    if (pendingConfirm) { pendingConfirm(true); pendingConfirm = null; }
  });
  if (runNo) runNo.addEventListener("click", () => {
    if (runConfirm) runConfirm.hidden = true;
    if (pendingConfirm) { pendingConfirm(false); pendingConfirm = null; }
  });
  if (runNext) runNext.addEventListener("click", () => {
    runNext.hidden = true;
    if (pendingNext) { pendingNext(); pendingNext = null; }
  });

  /* ---------------------------------------------------------
     Boot: show the current page URL + apply any saved view
  --------------------------------------------------------- */
  (async () => {
    setStatus("ready");
    try {
      const ctx = await readPage();
      const urlEl = $("context-url");
      if (urlEl) urlEl.textContent = prettyUrl(ctx.url);
    } catch (e) {
      const urlEl = $("context-url");
      if (urlEl) urlEl.textContent = "No page detected";
    }
    try {
      const cfg = AI ? await AI.getConfig() : {};
      if (scamAlert) scamAlert.checked = Boolean(cfg.scamAlert);
      setScamAlertUI(Boolean(cfg.scamAlert));
      if (EXT && cfg.scamAlert) {
        const tab = await getActiveTab();
        if (tab?.id != null) {
          await loadStoredScan(tab.id);
          chrome.runtime.sendMessage({ type: "KINDRED_SCAM_SCAN_NOW", tabId: tab.id }).catch(() => {});
        }
      }
      const host = await currentHost();
      const recipe = await getSite(host);
      if (recipe) {
        await applyRecipe(recipe);
        showBanner(host);
      }
    } catch { /* ignore */ }
  })();
})();
