/* Kindred "Guide Me" engine — lives on the page and renders an animated
   on-screen cursor, a large friendly tooltip, and a calm highlight that walk
   an elderly user through a task one step at a time. An AI planner in the side
   panel decides WHICH element and WHAT instruction; this script does the
   pointing, the talking, and the "did they do it yet?" detection. */
(() => {
  "use strict";

  // Chrome does not inject newly-added manifest scripts into tabs that were
  // already open when an extension is reloaded, and the side panel injects this
  // file on demand via chrome.scripting. This guard keeps re-injection safe and
  // idempotent so we never stack two cursors or two listeners on one page.
  if (globalThis.__kindredGuideInstalled) {
    return;
  }
  globalThis.__kindredGuideInstalled = true;

  // ---------------------------------------------------------------------------
  // Constants & module state
  // ---------------------------------------------------------------------------

  const TOP_Z = 2147483646; // one below the max so a host page can't be on top
  const WRAP_ID = "kindred-guide-root"; // wrapper that scopes all our styles
  const STYLE_ID = "kindred-guide-style";
  const GID_ATTR = "data-kindred-gid"; // stable per-element id we stamp on scan
  const MAX_ELEMENTS = 120; // cap so huge pages stay responsive
  const MAX_LABEL = 80; // characters of human-readable label we keep

  // Elements we consider "actionable" for the planner.
  const ACTION_SELECTOR = [
    "a[href]",
    "button",
    "[role=button]",
    "[role=link]",
    "input",
    "select",
    "textarea",
    "[onclick]",
    "[role=menuitem]",
    "[role=tab]",
    "[role=checkbox]",
  ].join(",");

  const reduceMotion =
    globalThis.matchMedia &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // id -> Element, populated on each scan so POINT can resolve quickly.
  const elementById = new Map();
  let gidCounter = 0;

  // Live UI references for the current step.
  let root = null; // fixed overlay wrapper
  let cursorEl = null; // the gliding pointer
  let ringEl = null; // pulsing ring over the target
  let tooltipEl = null; // instruction bubble
  let outlineEl = null; // crisp outline drawn around the target

  // Per-step bookkeeping so we can clean up between steps.
  let activeTarget = null;
  let activeId = null;
  let onDocClick = null; // document-level click listener for action detection
  let onInput = null; // focus/change listener for form fields
  let repositionRaf = 0; // throttles scroll/resize repositioning
  let scrollHandler = null;
  let resizeHandler = null;
  let cursorPlaced = false; // becomes true after the first POINT so we glide

  // ---------------------------------------------------------------------------
  // Visibility & labelling helpers
  // ---------------------------------------------------------------------------

  /* A node is "visible" if it has a layout box and isn't hidden by CSS. We allow
     offscreen-but-visible elements (the planner may scroll to them later). */
  function isVisible(el) {
    try {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return false;
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        parseFloat(style.opacity || "1") === 0
      ) {
        return false;
      }
      // Disabled or aria-hidden controls aren't actionable.
      if (el.disabled) return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      return true;
    } catch {
      return false;
    }
  }

  function clip(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > MAX_LABEL ? value.slice(0, MAX_LABEL - 1) + "…" : value;
  }

  /* Best human-readable label for an element, trying the most meaningful
     sources first and falling back gracefully. */
  function labelFor(el) {
    try {
      const inner = clip(el.innerText || "");
      if (inner) return inner;
      const aria = clip(el.getAttribute("aria-label"));
      if (aria) return aria;
      const placeholder = clip(el.getAttribute("placeholder"));
      if (placeholder) return placeholder;
      const value = clip(el.value);
      if (value) return value;
      const img = el.querySelector && el.querySelector("img[alt]");
      const alt = img && clip(img.getAttribute("alt"));
      if (alt) return alt;
      const title = clip(el.getAttribute("title"));
      if (title) return title;
      return ""; // unlabelled but still actionable
    } catch {
      return "";
    }
  }

  /* The element's role, or a sensible default inferred from tag/type so the
     planner gets a useful hint even when no explicit role is set. */
  function roleFor(el) {
    try {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit.toLowerCase();
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "button" || type === "submit" || type === "reset") return "button";
        if (type === "range") return "slider";
        return "textbox";
      }
      return "button"; // [onclick] and friends behave like buttons
    } catch {
      return "button";
    }
  }

  // ---------------------------------------------------------------------------
  // SCAN — stamp ids on actionable elements and report them to the planner
  // ---------------------------------------------------------------------------

  function scan() {
    elementById.clear();
    const out = [];
    let candidates = [];
    try {
      candidates = Array.from(document.querySelectorAll(ACTION_SELECTOR));
    } catch {
      candidates = [];
    }

    for (const el of candidates) {
      if (out.length >= MAX_ELEMENTS) break;
      // Never offer our own overlay UI as a target.
      if (el.closest && el.closest("#" + WRAP_ID)) continue;
      if (!isVisible(el)) continue;

      let id = el.getAttribute(GID_ATTR);
      if (!id) {
        id = "g" + ++gidCounter;
        try {
          el.setAttribute(GID_ATTR, id);
        } catch {
          continue;
        }
      }
      elementById.set(id, el);
      out.push({
        id,
        label: labelFor(el),
        role: roleFor(el),
        tag: el.tagName.toLowerCase(),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Overlay construction (style tag + DOM scaffolding)
  // ---------------------------------------------------------------------------

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // Warm, calm palette. Everything is scoped under the wrapper id and forced
    // with !important so host-page CSS can't distort our guidance UI.
    style.textContent = `
      #${WRAP_ID}{position:fixed;inset:0;z-index:${TOP_Z};pointer-events:none;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        color:#37352f;}
      #${WRAP_ID} *{box-sizing:border-box;}

      /* The gliding pointer. transform is animated so it slides to the target. */
      #${WRAP_ID} .kindred-cursor{position:fixed;top:0;left:0;width:36px;height:36px;
        margin:0;pointer-events:none;will-change:transform;
        filter:drop-shadow(0 3px 6px rgba(55,53,47,.35));z-index:3;
        transform:translate3d(-100px,-100px,0);}
      #${WRAP_ID} .kindred-cursor.kindred-glide{
        transition:transform 700ms cubic-bezier(.22,.61,.36,1);}

      /* Soft pulsing ring that draws the eye to the target. */
      #${WRAP_ID} .kindred-ring{position:fixed;pointer-events:none;border-radius:999px;
        border:3px solid #2383e2;z-index:1;
        box-shadow:0 0 0 4px rgba(35,131,226,.18);
        animation:kindred-pulse 1.6s ease-in-out infinite;}
      @keyframes kindred-pulse{
        0%{transform:scale(1);opacity:.95;}
        50%{transform:scale(1.08);opacity:.55;}
        100%{transform:scale(1);opacity:.95;}}

      /* A crisp outline so the exact element is unmistakable. */
      #${WRAP_ID} .kindred-outline{position:fixed;pointer-events:none;z-index:1;
        border:2px solid #2383e2;border-radius:8px;
        box-shadow:0 0 0 9999px rgba(0,0,0,0);}

      /* Big, readable instruction bubble. */
      #${WRAP_ID} .kindred-tip{position:fixed;pointer-events:none;z-index:4;
        max-width:340px;background:#ffffff;border:1px solid #eceae6;
        border-radius:16px;padding:16px 18px;
        box-shadow:0 8px 24px rgba(55,53,47,.18);}
      #${WRAP_ID} .kindred-tip-step{display:block;font-size:12px;font-weight:700;
        letter-spacing:.06em;text-transform:uppercase;color:#2383e2;
        margin:0 0 6px;}
      #${WRAP_ID} .kindred-tip-text{display:block;font-size:17px;line-height:1.5;
        font-weight:500;color:#37352f;margin:0;}
      #${WRAP_ID} .kindred-tip-mark{display:flex;align-items:center;gap:6px;
        margin-top:12px;font-size:12px;font-weight:600;color:#9b978f;}
      #${WRAP_ID} .kindred-tip-dot{width:10px;height:10px;border-radius:50%;
        background:#2383e2;display:inline-block;}

      @media (prefers-reduced-motion: reduce){
        #${WRAP_ID} .kindred-cursor.kindred-glide{transition:none!important;}
        #${WRAP_ID} .kindred-ring{animation:none!important;}
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /* Build the overlay layer once. All pieces live inside a single fixed wrapper
     with pointer-events:none so they never intercept the user's real clicks. */
  function ensureOverlay() {
    ensureStyle();
    if (root && root.isConnected) return;

    root = document.createElement("div");
    root.id = WRAP_ID;
    root.setAttribute("aria-hidden", "true");

    outlineEl = document.createElement("div");
    outlineEl.className = "kindred-outline";

    ringEl = document.createElement("div");
    ringEl.className = "kindred-ring";

    tooltipEl = document.createElement("div");
    tooltipEl.className = "kindred-tip";

    cursorEl = document.createElement("div");
    cursorEl.className = "kindred-cursor";
    // An SVG hand/arrow pointer. White fill with a teal accent ring on the wrist
    // so it reads clearly over any background.
    cursorEl.innerHTML = `
      <svg viewBox="0 0 36 36" width="36" height="36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M9 5.5 L9 25 L13.5 21 L17 29.5 L21 28 L17.5 19.5 L24 19 Z"
          fill="#ffffff" stroke="#37352f" stroke-width="1.6" stroke-linejoin="round"/>
        <circle cx="9" cy="5.5" r="2.4" fill="#2383e2"/>
      </svg>`;

    root.appendChild(outlineEl);
    root.appendChild(ringEl);
    root.appendChild(tooltipEl);
    root.appendChild(cursorEl);
    (document.body || document.documentElement).appendChild(root);
  }

  // ---------------------------------------------------------------------------
  // Positioning the cursor, ring, outline and tooltip around the target
  // ---------------------------------------------------------------------------

  /* Place every overlay piece relative to the target's current viewport rect.
     Called after scroll-into-view and on every scroll/resize so the guidance
     stays glued to the element as the page moves. */
  function position(instruction, index, total) {
    if (!activeTarget || !activeTarget.isConnected) return;
    let rect;
    try {
      rect = activeTarget.getBoundingClientRect();
    } catch {
      return;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // --- Ring: a circle a little larger than the target, centred on it. ---
    const ringSize = Math.max(rect.width, rect.height) + 22;
    ringEl.style.width = ringSize + "px";
    ringEl.style.height = ringSize + "px";
    ringEl.style.left = centerX - ringSize / 2 + "px";
    ringEl.style.top = centerY - ringSize / 2 + "px";

    // --- Outline: hugs the element's box with a small pad. ---
    const pad = 4;
    outlineEl.style.left = rect.left - pad + "px";
    outlineEl.style.top = rect.top - pad + "px";
    outlineEl.style.width = rect.width + pad * 2 + "px";
    outlineEl.style.height = rect.height + pad * 2 + "px";

    // --- Cursor: hover just below-right of the centre, like a real pointer. ---
    const cursorX = centerX - 6;
    const cursorY = centerY - 4;
    // Toggle the glide transition: skip it on first placement and when the user
    // prefers reduced motion, otherwise let it slide smoothly to the target.
    if (cursorPlaced && !reduceMotion) {
      cursorEl.classList.add("kindred-glide");
    } else {
      cursorEl.classList.remove("kindred-glide");
    }
    cursorEl.style.transform = `translate3d(${cursorX}px, ${cursorY}px, 0)`;
    cursorPlaced = true;

    // --- Tooltip: fill text, then auto-place above or below with clamping. ---
    if (typeof instruction === "string") {
      const stepLabel =
        index && total ? `Step ${index} of ${total}` : "Guide";
      tooltipEl.innerHTML = "";
      const step = document.createElement("span");
      step.className = "kindred-tip-step";
      step.textContent = stepLabel;
      const text = document.createElement("span");
      text.className = "kindred-tip-text";
      text.textContent = instruction; // textContent — never inject page/AI HTML
      const mark = document.createElement("span");
      mark.className = "kindred-tip-mark";
      const dot = document.createElement("span");
      dot.className = "kindred-tip-dot";
      const name = document.createElement("span");
      name.textContent = "Kindred";
      mark.appendChild(dot);
      mark.appendChild(name);
      tooltipEl.appendChild(step);
      tooltipEl.appendChild(text);
      tooltipEl.appendChild(mark);
    }

    // Measure after content is set so placement uses the real size.
    const tipRect = tooltipEl.getBoundingClientRect();
    const margin = 12;
    const gap = 16;

    // Horizontal: centre on the target, then clamp inside the viewport.
    let left = centerX - tipRect.width / 2;
    left = Math.max(margin, Math.min(left, vw - tipRect.width - margin));

    // Vertical: prefer below the element; flip above if there isn't room.
    const roomBelow = vh - rect.bottom;
    const roomAbove = rect.top;
    let top;
    if (roomBelow >= tipRect.height + gap || roomBelow >= roomAbove) {
      top = rect.bottom + gap;
    } else {
      top = rect.top - tipRect.height - gap;
    }
    top = Math.max(margin, Math.min(top, vh - tipRect.height - margin));

    tooltipEl.style.left = left + "px";
    tooltipEl.style.top = top + "px";
  }

  /* Re-run positioning on scroll/resize, throttled to one update per frame so a
     scrolling page doesn't thrash layout. */
  function scheduleReposition() {
    if (repositionRaf) return;
    repositionRaf = requestAnimationFrame(() => {
      repositionRaf = 0;
      try {
        position();
      } catch {
        /* a vanishing target shouldn't throw */
      }
    });
  }

  // ---------------------------------------------------------------------------
  // POINT — aim the guidance at one element and watch for the user acting
  // ---------------------------------------------------------------------------

  function point(message) {
    const id = message.id;
    let target = id && elementById.get(id);
    if (!target || !target.isConnected) {
      // Fall back to a live DOM lookup in case the map is stale.
      try {
        target = document.querySelector(`[${GID_ATTR}="${String(id).replace(/"/g, "")}"]`);
      } catch {
        target = null;
      }
    }
    if (!target || !target.isConnected) return false;

    detachStepListeners(); // tidy any previous step before starting this one
    ensureOverlay();

    activeTarget = target;
    activeId = id;

    // Smoothly bring the element to the middle of the screen.
    try {
      target.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
        inline: "center",
      });
    } catch {
      /* older engines may reject the options object */
      try {
        target.scrollIntoView();
      } catch {}
    }

    // Place immediately, then again shortly after so the smooth scroll settles.
    position(message.instruction, message.index, message.total);
    setTimeout(() => {
      try {
        position(message.instruction, message.index, message.total);
      } catch {}
    }, reduceMotion ? 0 : 360);

    attachStepListeners(message.instruction, message.index, message.total);
    return true;
  }

  // ---------------------------------------------------------------------------
  // User-action detection
  // ---------------------------------------------------------------------------

  function notify(event) {
    try {
      chrome.runtime
        .sendMessage({ type: "KINDRED_GUIDE_EVENT", event, id: activeId })
        .catch(() => {});
    } catch {
      /* extension context may be gone during reload */
    }
  }

  /* Did the user interact with the element we're pointing at? We accept a click
     anywhere inside the target (or a node that resolves back to it via gid). */
  function hitsTarget(node) {
    if (!activeTarget || !node) return false;
    try {
      if (activeTarget.contains(node)) return true;
      const tagged = node.closest && node.closest(`[${GID_ATTR}="${activeId}"]`);
      return Boolean(tagged);
    } catch {
      return false;
    }
  }

  function attachStepListeners(instruction, index, total) {
    // Click detection (capture phase so we still hear it if the page stops it).
    onDocClick = (e) => {
      try {
        const node = e.target;
        if (hitsTarget(node)) {
          notify("acted");
        } else if (
          node &&
          node.closest &&
          node.closest(ACTION_SELECTOR) &&
          !(node.closest && node.closest("#" + WRAP_ID))
        ) {
          // They clicked a clearly different interactive element. Best-effort
          // signal; we stay quiet for clicks on plain text/background.
          notify("clicked-other");
        }
      } catch {
        /* defensive: a click handler must never throw */
      }
    };
    document.addEventListener("click", onDocClick, true);

    // For form fields, focus or change also counts as "acted".
    const tag = activeTarget.tagName ? activeTarget.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      onInput = (e) => {
        try {
          if (hitsTarget(e.target)) notify("acted");
        } catch {}
      };
      activeTarget.addEventListener("focus", onInput, true);
      activeTarget.addEventListener("change", onInput, true);
    }

    // Keep the guidance pinned to the element as the page scrolls/resizes.
    scrollHandler = () => scheduleReposition();
    resizeHandler = () => scheduleReposition();
    window.addEventListener("scroll", scrollHandler, true);
    window.addEventListener("resize", resizeHandler, true);
  }

  /* Remove all per-step listeners so steps never accumulate handlers. */
  function detachStepListeners() {
    try {
      if (onDocClick) document.removeEventListener("click", onDocClick, true);
    } catch {}
    onDocClick = null;

    try {
      if (onInput && activeTarget) {
        activeTarget.removeEventListener("focus", onInput, true);
        activeTarget.removeEventListener("change", onInput, true);
      }
    } catch {}
    onInput = null;

    try {
      if (scrollHandler) window.removeEventListener("scroll", scrollHandler, true);
      if (resizeHandler) window.removeEventListener("resize", resizeHandler, true);
    } catch {}
    scrollHandler = null;
    resizeHandler = null;

    if (repositionRaf) {
      cancelAnimationFrame(repositionRaf);
      repositionRaf = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // CLEAR — tear everything down
  // ---------------------------------------------------------------------------

  function clear() {
    detachStepListeners();
    try {
      if (root && root.parentNode) root.parentNode.removeChild(root);
    } catch {}
    try {
      const style = document.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
    } catch {}
    root = cursorEl = ringEl = tooltipEl = outlineEl = null;
    activeTarget = null;
    activeId = null;
    cursorPlaced = false;
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "KINDRED_GUIDE_SCAN") {
      let elements = [];
      try {
        elements = scan();
      } catch {
        elements = [];
      }
      sendResponse({ elements });
      return true; // keep the channel open for the async-style response
    }

    if (message.type === "KINDRED_GUIDE_POINT") {
      let ok = false;
      try {
        ok = point(message);
      } catch {
        ok = false;
      }
      sendResponse({ ok });
      return true;
    }

    if (message.type === "KINDRED_GUIDE_CLEAR") {
      try {
        clear();
      } catch {}
      sendResponse({ ok: true });
      return true;
    }
  });

  // Let the side panel know the engine is live and ready to take commands.
  try {
    chrome.runtime.sendMessage({ type: "KINDRED_GUIDE_READY" }).catch(() => {});
  } catch {
    /* extension context may be reloading */
  }
})();
