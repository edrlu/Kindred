/* Kindred Website Autopilot — on-page executor.

   An AI agent loop in the side panel decides one action at a time. This content
   script is the hands and eyes on the page:
     - OBSERVE: report the page's visible, actionable elements so the agent can choose.
     - ACT: perform exactly one requested action (click, type, select, scroll, navigate).
     - STATUS: show a calm, always-visible banner so the elderly user can follow along.
     - CLEAR: tear everything down.

   Safety first: the user always sees a status banner with a big STOP button and is
   always in control. This script only ever performs the single action it is told to —
   the agent loop and any user gating live in the side panel. It never auto-submits
   payments or places orders on its own. */
(() => {
  "use strict";

  // The side panel injects this on demand via chrome.scripting, and Chrome may
  // also have injected it via the manifest. This guard keeps re-injection safe.
  if (globalThis.__kindredAutopilotInstalled) {
    return;
  }
  globalThis.__kindredAutopilotInstalled = true;

  const AID_ATTR = "data-kindred-aid";
  const STYLE_ID = "kindred-autopilot-style";
  const BANNER_ID = "kindred-autopilot-banner";
  const HIGHLIGHT_CLASS = "kindred-autopilot-flash";
  const MAX_ELEMENTS = 120;
  const LABEL_MAX = 80;
  const VALUE_MAX = 60;
  const TEXT_MAX = 3000;

  // id -> element, rebuilt on each OBSERVE so the agent's ids line up with the DOM.
  let elementMap = new Map();
  let flashTimer = null;

  /* ------------------------------------------------------------------ utils */

  function clamp(value, max) {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) : text;
  }

  // A best-effort visibility check. The page DOM can shift under us, so anything
  // that throws is simply treated as not visible.
  function isVisible(el) {
    try {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      if (el.closest("#" + BANNER_ID)) return false; // never report our own UI
      if (el.hasAttribute("hidden")) return false;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT" && type === "hidden") return false;
      const style = getComputedStyle(el);
      if (!style) return false;
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      if (parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      // Must intersect the viewport (with a little slack for things just off-screen).
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (rect.bottom < -40 || rect.top > vh + 40) return false;
      if (rect.right < -40 || rect.left > vw + 40) return false;
      return true;
    } catch {
      return false;
    }
  }

  function roleOf(el) {
    try {
      const explicit = (el.getAttribute("role") || "").trim().toLowerCase();
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a" && el.hasAttribute("href")) return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "select";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "button" || type === "submit" || type === "reset") return "button";
        return "textbox";
      }
      if (el.isContentEditable) return "textbox";
      return tag;
    } catch {
      return "";
    }
  }

  function labelOf(el) {
    try {
      const tag = el.tagName.toLowerCase();
      const candidates = [
        el.getAttribute("aria-label"),
        // innerText reflects what the user actually sees.
        tag === "input" || tag === "select" || tag === "textarea" ? "" : el.innerText,
        el.getAttribute("placeholder"),
        el.getAttribute("alt"),
        el.getAttribute("title"),
        el.getAttribute("name"),
        tag === "input" && (el.getAttribute("type") || "text").toLowerCase() !== "password" ? el.value : "",
      ];
      for (const candidate of candidates) {
        const text = clamp(candidate, LABEL_MAX);
        if (text) return text;
      }
      return "";
    } catch {
      return "";
    }
  }

  function valueOf(el) {
    try {
      const tag = el.tagName.toLowerCase();
      if (tag === "select") {
        const opt = el.options && el.options[el.selectedIndex];
        return clamp(opt ? opt.text || opt.value : el.value, VALUE_MAX);
      }
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        return type === "password" ? "" : clamp(el.value, VALUE_MAX);
      }
      if (tag === "textarea") return clamp(el.value, VALUE_MAX);
      if (el.isContentEditable) return clamp(el.textContent, VALUE_MAX);
      return "";
    } catch {
      return "";
    }
  }

  /* --------------------------------------------------------------- observe */

  const ACTIONABLE_SELECTOR = [
    "a[href]",
    "button",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=checkbox]",
    "[role=radio]",
    "input",
    "select",
    "textarea",
    "[contenteditable]",
    "[contenteditable=true]",
  ].join(",");

  function observe() {
    elementMap = new Map();
    const elements = [];
    let candidates;
    try {
      candidates = document.querySelectorAll(ACTIONABLE_SELECTOR);
    } catch {
      candidates = [];
    }

    const seen = new Set();
    let counter = 0;
    for (const el of candidates) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;

      const id = "a" + counter++;
      try {
        el.setAttribute(AID_ATTR, id);
      } catch {
        // Some nodes (e.g. inside foreign content) may reject attributes; skip.
        continue;
      }
      elementMap.set(id, el);
      elements.push({
        id,
        label: labelOf(el),
        role: roleOf(el),
        tag: el.tagName.toLowerCase(),
        value: valueOf(el),
      });
    }

    let text = "";
    try {
      text = clamp(document.body ? document.body.innerText : "", TEXT_MAX);
    } catch {
      text = "";
    }

    return {
      url: location.href,
      title: document.title,
      elements,
      text,
    };
  }

  /* ------------------------------------------------------------------- act */

  function findById(id) {
    if (id == null) return null;
    const fromMap = elementMap.get(id);
    if (fromMap && fromMap.isConnected) return fromMap;
    // Fallback: the DOM may have been re-rendered; look the marker up directly.
    try {
      return document.querySelector(`[${AID_ATTR}="${CSS.escape(String(id))}"]`);
    } catch {
      return null;
    }
  }

  function flash(el) {
    try {
      if (!el || !el.classList) return;
      ensureStyle();
      clearTimeout(flashTimer);
      document.querySelectorAll("." + HIGHLIGHT_CLASS).forEach((node) => {
        node.classList.remove(HIGHLIGHT_CLASS);
      });
      el.classList.add(HIGHLIGHT_CLASS);
      flashTimer = setTimeout(() => {
        try { el.classList.remove(HIGHLIGHT_CLASS); } catch { /* gone */ }
      }, 1400);
    } catch {
      /* highlighting is cosmetic; never let it break an action */
    }
  }

  function scrollIntoView(el) {
    try {
      const reduce = matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", inline: "center", behavior: reduce ? "auto" : "smooth" });
    } catch {
      try { el.scrollIntoView(); } catch { /* ignore */ }
    }
  }

  function fireInputEvents(el) {
    // Frameworks (React/Vue/etc.) listen for these to register a value change.
    try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch { /* ignore */ }
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* ignore */ }
  }

  function setNativeValue(el, value) {
    // Assigning .value directly can be swallowed by React's value tracker, so we
    // go through the native setter when we can.
    try {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement && window.HTMLInputElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, value);
        return;
      }
    } catch {
      /* fall through to a plain assignment */
    }
    el.value = value;
  }

  function actClick(action) {
    const el = findById(action.id);
    if (!el) return { ok: false, error: "element not found" };
    scrollIntoView(el);
    flash(el);
    el.click();
    return { ok: true };
  }

  function actType(action) {
    const el = findById(action.id);
    if (!el) return { ok: false, error: "element not found" };
    scrollIntoView(el);
    flash(el);
    const text = action.text == null ? "" : String(action.text);
    try { el.focus(); } catch { /* ignore */ }
    if (el.isContentEditable) {
      el.textContent = text;
    } else {
      setNativeValue(el, text);
    }
    fireInputEvents(el);
    return { ok: true };
  }

  function actSelect(action) {
    const el = findById(action.id);
    if (!el) return { ok: false, error: "element not found" };
    if (el.tagName !== "SELECT") return { ok: false, error: "not a select element" };
    scrollIntoView(el);
    flash(el);
    const want = String(action.value == null ? "" : action.value).trim().toLowerCase();
    const options = Array.from(el.options || []);
    // Prefer an exact value/text match, then fall back to a contains match.
    let match = options.find((opt) => opt.value.toLowerCase() === want || (opt.text || "").trim().toLowerCase() === want);
    if (!match) {
      match = options.find((opt) => opt.value.toLowerCase().includes(want) || (opt.text || "").toLowerCase().includes(want));
    }
    if (!match) return { ok: false, error: "no matching option" };
    el.value = match.value;
    fireInputEvents(el);
    return { ok: true, note: "selected " + clamp(match.text || match.value, VALUE_MAX) };
  }

  function actScroll(action) {
    const direction = (action.direction || "down").toLowerCase();
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    // A bit less than a full viewport keeps continuity between scrolls.
    const amount = Math.round(vh * 0.85) * (direction === "up" ? -1 : 1);
    try {
      const reduce = matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollBy({ top: amount, left: 0, behavior: reduce ? "auto" : "smooth" });
    } catch {
      window.scrollBy(0, amount);
    }
    return { ok: true };
  }

  function actNavigate(action) {
    const url = String(action.url || "").trim();
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch {
      return { ok: false, error: "invalid url" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "only http/https navigation is allowed" };
    }
    location.href = parsed.href;
    return { ok: true };
  }

  function act(action) {
    try {
      if (!action || typeof action.type !== "string") {
        return { ok: false, error: "unknown action" };
      }
      switch (action.type) {
        case "click": return actClick(action);
        case "type": return actType(action);
        case "select": return actSelect(action);
        case "scroll": return actScroll(action);
        case "navigate": return actNavigate(action);
        case "done": return { ok: true };
        default: return { ok: false, error: "unknown action" };
      }
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  }

  /* ------------------------------------------------------------ status UI */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID}{
        position:fixed!important;top:14px!important;left:50%!important;
        transform:translateX(-50%)!important;z-index:2147483646!important;
        display:flex!important;align-items:center!important;gap:14px!important;
        max-width:min(640px,calc(100vw - 28px))!important;
        box-sizing:border-box!important;padding:11px 16px!important;
        background:#ffffff!important;border:1px solid #ececeb!important;
        border-radius:14px!important;
        box-shadow:0 8px 28px rgba(55,53,47,0.16),0 1px 3px rgba(55,53,47,0.10)!important;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif!important;
        color:#37352f!important;line-height:1.4!important;
        pointer-events:none!important;animation:kindred-ap-in .22s ease-out!important;
      }
      #${BANNER_ID} *{box-sizing:border-box!important;}
      #${BANNER_ID} .kindred-ap-brand{
        display:flex!important;align-items:center!important;gap:7px!important;
        flex:0 0 auto!important;font-size:12px!important;font-weight:600!important;
        color:#787774!important;white-space:nowrap!important;
        padding-right:13px!important;border-right:1px solid #ececeb!important;
      }
      #${BANNER_ID} .kindred-ap-dot{
        width:9px!important;height:9px!important;border-radius:50%!important;
        background:#b14a40!important;flex:0 0 auto!important;
      }
      #${BANNER_ID} .kindred-ap-text{
        flex:1 1 auto!important;min-width:0!important;
        font-size:16px!important;font-weight:450!important;color:#37352f!important;
        overflow:hidden!important;text-overflow:ellipsis!important;
        display:-webkit-box!important;-webkit-line-clamp:2!important;
        -webkit-box-orient:vertical!important;
      }
      #${BANNER_ID}.kindred-ap-idle .kindred-ap-text{color:#787774!important;}
      #${BANNER_ID} .kindred-ap-stop{
        flex:0 0 auto!important;pointer-events:auto!important;cursor:pointer!important;
        appearance:none!important;-webkit-appearance:none!important;
        font-family:inherit!important;font-size:15px!important;font-weight:700!important;
        letter-spacing:.02em!important;color:#b14a40!important;background:#ffffff!important;
        border:2px solid #b14a40!important;border-radius:10px!important;
        padding:8px 18px!important;margin:0!important;line-height:1.1!important;
        transition:background .12s ease,color .12s ease!important;
      }
      #${BANNER_ID} .kindred-ap-stop:hover{background:#b14a40!important;color:#ffffff!important;}
      #${BANNER_ID} .kindred-ap-stop:disabled{
        opacity:.55!important;cursor:default!important;background:#f7f7f5!important;
        color:#b14a40!important;
      }
      .${HIGHLIGHT_CLASS}{
        outline:3px solid #b14a40!important;outline-offset:2px!important;
        border-radius:4px!important;
        box-shadow:0 0 0 4px rgba(177,74,64,0.18)!important;
        transition:outline-color .15s ease,box-shadow .15s ease!important;
      }
      @keyframes kindred-ap-in{
        from{opacity:0;transform:translateX(-50%) translateY(-8px);}
        to{opacity:1;transform:translateX(-50%) translateY(0);}
      }
      @media (prefers-reduced-motion: reduce){
        #${BANNER_ID}{animation:none!important;}
        .${HIGHLIGHT_CLASS}{transition:none!important;}
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildBanner() {
    const banner = document.createElement("div");
    banner.id = BANNER_ID;
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");

    const brand = document.createElement("div");
    brand.className = "kindred-ap-brand";
    const dot = document.createElement("span");
    dot.className = "kindred-ap-dot";
    const brandLabel = document.createElement("span");
    brandLabel.textContent = "Kindred Autopilot";
    brand.appendChild(dot);
    brand.appendChild(brandLabel);

    const text = document.createElement("div");
    text.className = "kindred-ap-text";
    text.textContent = "Getting ready…";

    const stop = document.createElement("button");
    stop.className = "kindred-ap-stop";
    stop.type = "button";
    stop.textContent = "STOP";
    stop.setAttribute("aria-label", "Stop the autopilot");
    stop.addEventListener("click", onStopClick);

    banner.appendChild(brand);
    banner.appendChild(text);
    banner.appendChild(stop);
    return banner;
  }

  function getBanner() {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      ensureStyle();
      banner = buildBanner();
      (document.body || document.documentElement).appendChild(banner);
    }
    return banner;
  }

  function onStopClick() {
    // Tell the side panel to halt the agent loop, and immediately reflect that
    // in the banner so the user sees their press took effect.
    chrome.runtime.sendMessage({ type: "KINDRED_AUTOPILOT_EVENT", event: "stop" }).catch(() => {});
    const banner = document.getElementById(BANNER_ID);
    if (!banner) return;
    banner.classList.add("kindred-ap-idle");
    const text = banner.querySelector(".kindred-ap-text");
    if (text) text.textContent = "Stopping…";
    const stop = banner.querySelector(".kindred-ap-stop");
    if (stop) {
      stop.disabled = true;
      stop.textContent = "Stopping…";
    }
  }

  function showStatus(message) {
    const running = message.running !== false;
    const banner = getBanner();
    const text = banner.querySelector(".kindred-ap-text");
    const stop = banner.querySelector(".kindred-ap-stop");

    if (text) {
      const provided = clamp(message.text, 240);
      text.textContent = provided || (running ? "Working…" : "Finished.");
    }
    if (running) {
      banner.classList.remove("kindred-ap-idle");
      if (stop) {
        stop.disabled = false;
        stop.textContent = "STOP";
      }
    } else {
      // Finished/idle: keep the banner so the user has closure, drop the urgency.
      banner.classList.add("kindred-ap-idle");
      if (stop) {
        stop.disabled = true;
        stop.textContent = "Done";
      }
    }
  }

  function clearAll() {
    clearTimeout(flashTimer);
    const banner = document.getElementById(BANNER_ID);
    if (banner) {
      const stop = banner.querySelector(".kindred-ap-stop");
      if (stop) stop.removeEventListener("click", onStopClick);
      banner.remove();
    }
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    document.querySelectorAll("." + HIGHLIGHT_CLASS).forEach((node) => {
      try { node.classList.remove(HIGHLIGHT_CLASS); } catch { /* ignore */ }
    });
    document.querySelectorAll("[" + AID_ATTR + "]").forEach((node) => {
      try { node.removeAttribute(AID_ATTR); } catch { /* ignore */ }
    });
    elementMap = new Map();
  }

  /* --------------------------------------------------------------- wiring */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;
    try {
      switch (message.type) {
        case "KINDRED_AUTOPILOT_OBSERVE":
          sendResponse(observe());
          return true;
        case "KINDRED_AUTOPILOT_ACT":
          sendResponse(act(message.action));
          return true;
        case "KINDRED_AUTOPILOT_STATUS":
          showStatus(message);
          sendResponse({ ok: true });
          return true;
        case "KINDRED_AUTOPILOT_CLEAR":
          clearAll();
          sendResponse({ ok: true });
          return true;
        default:
          return;
      }
    } catch (error) {
      // Never let a changing page throw out of the listener.
      try { sendResponse({ ok: false, error: (error && error.message) || String(error) }); } catch { /* ignore */ }
      return true;
    }
  });

  // Let the side panel know the executor is live on this page.
  chrome.runtime.sendMessage({ type: "KINDRED_AUTOPILOT_READY" }).catch(() => {});
})();
