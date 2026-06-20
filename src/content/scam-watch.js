/* Kindred scam alert — stays on the page and asks the service worker to
   rescan after meaningful dynamic changes. */
(() => {
  "use strict";

  // Chrome does not inject newly-added manifest scripts into tabs that were
  // already open when an extension is reloaded. The service worker therefore
  // injects this file on demand too; this guard keeps that safe and idempotent.
  if (globalThis.__kindredScamWatchInstalled) {
    return;
  }
  globalThis.__kindredScamWatchInstalled = true;

  const MARK_CLASS = "kindred-scam-highlight";
  let enabled = false;
  let changeTimer = null;
  let fastScanTimer = null;
  let ignoreMutationsUntil = 0;
  let lastPageSignature = "";
  const FAST_SCAM_PATTERNS = [
    /\burgent\s*:\s*.{0,90}\b(?:account|bank).{0,60}\b(?:closed|suspended|locked|verify)\b/i,
    /\b(?:verify|confirm|update)\s+(?:your\s+)?(?:account|banking|payment).{0,90}\b(?:immediately|urgent|today|now)\b/i,
    /\b(?:gift\s*card|wire\s*transfer|bitcoin|crypto(?:currency)?).{0,90}\b(?:urgent|immediately|today|now)\b/i,
    /\b(?:final\s+warning|immediate\s+action|required|account\s+(?:will\s+be\s+)?(?:closed|suspended|locked))\b/i,
  ];

  function clearHighlights() {
    ignoreMutationsUntil = Date.now() + 500;
    document.querySelectorAll(`mark.${MARK_CLASS}`).forEach((mark) => {
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
    });
    document.normalize();
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function addStyle() {
    ignoreMutationsUntil = Date.now() + 500;
    if (document.getElementById("kindred-scam-style")) return;
    const style = document.createElement("style");
    style.id = "kindred-scam-style";
    style.textContent = `
      mark.${MARK_CLASS}{background:#fee2e2!important;color:#991b1b!important;
        outline:2px solid #ef4444!important;outline-offset:1px!important;
        border-radius:2px!important;padding:0 2px!important;box-decoration-break:clone!important;}
      mark.${MARK_CLASS}::after{content:"SCAM ALERT"!important;display:inline-block!important;
        margin-left:5px!important;padding:1px 4px!important;border-radius:3px!important;
        vertical-align:middle!important;background:#b91c1c!important;color:#fff!important;
        font:700 9px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;
        letter-spacing:.05em!important;white-space:nowrap!important;}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function highlightPhrase(phrase) {
    ignoreMutationsUntil = Date.now() + 500;
    const needle = normalize(phrase);
    if (needle.length < 5 || needle.length > 350) return;
    const lowerNeedle = needle.toLocaleLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.parentElement || node.parentElement.closest("script,style,noscript,textarea,input,select,option,button,mark." + MARK_CLASS)) {
          return NodeFilter.FILTER_REJECT;
        }
        return normalize(node.nodeValue).toLocaleLowerCase().includes(lowerNeedle)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes = [];
    while (walker.nextNode() && nodes.length < 20) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const source = node.nodeValue || "";
      const index = source.toLocaleLowerCase().indexOf(String(phrase).toLocaleLowerCase());
      if (index < 0) return;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + String(phrase).length);
      const mark = document.createElement("mark");
      mark.className = MARK_CLASS;
      mark.dataset.kindred = "scam";
      try { range.surroundContents(mark); } catch { /* a changed DOM can invalidate the range */ }
    });
  }

  // A small local check makes obvious scams visible immediately. The AI scan
  // still follows with a fuller assessment and can add more precise labels.
  function runFastScan() {
    if (!enabled || !document.body) return;
    clearHighlights();
    addStyle();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.parentElement || node.parentElement.closest("script,style,noscript,textarea,input,select,option,button,mark." + MARK_CLASS)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode() && nodes.length < 5000) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const source = node.nodeValue || "";
      const match = FAST_SCAM_PATTERNS.map((pattern) => source.match(pattern)).find(Boolean);
      if (!match || match.index == null) return;
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const mark = document.createElement("mark");
      mark.className = MARK_CLASS;
      mark.dataset.kindred = "scam";
      try { range.surroundContents(mark); } catch { /* DOM changed while scanning */ }
    });
  }

  function runFastScanSoon() {
    if (!enabled) return;
    clearTimeout(fastScanTimer);
    fastScanTimer = setTimeout(runFastScan, 80);
  }

  function pageSignature() {
    const text = normalize(document.body?.innerText || "")
      .replace(/\bSCAM ALERT\b/g, "")
      .slice(0, 5000);
    return `${location.href}\n${document.title}\n${text}`;
  }

  function announcePageChange(force = false) {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const signature = pageSignature();
      if (!force && signature === lastPageSignature) return;
      lastPageSignature = signature;
      runFastScanSoon();
      chrome.runtime.sendMessage({ type: "KINDRED_PAGE_CHANGED", url: location.href, title: document.title }).catch(() => {});
    }, 300);
  }

  const observer = new MutationObserver((mutations) => {
    if (Date.now() < ignoreMutationsUntil) return;
    const changedByKindred = mutations.every((m) => {
      const target = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
      return target && target.closest && target.closest("mark." + MARK_CLASS);
    });
    if (!changedByKindred) {
      announcePageChange();
    }
  });
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (message.type === "KINDRED_SCAM_ALERT") {
      enabled = Boolean(message.enabled);
      clearHighlights();
      if (enabled) {
        runFastScanSoon();
        announcePageChange(true);
      }
      return;
    }
    if (message.type === "KINDRED_SCAM_RESULTS") {
      clearHighlights();
      if (!enabled || !Array.isArray(message.matches)) return;
      addStyle();
      // Preserve immediate local warnings even if the AI response omits them.
      runFastScan();
      message.matches.forEach(highlightPhrase);
    }
  });

  window.addEventListener("popstate", () => announcePageChange(true));
  window.addEventListener("hashchange", () => announcePageChange(true));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) announcePageChange();
  });

  lastPageSignature = pageSignature();
  chrome.runtime.sendMessage({ type: "KINDRED_SCAM_WATCH_READY" }).catch(() => {});
})();
