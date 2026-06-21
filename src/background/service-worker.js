// Kindred — background service worker
// Owns the always-on scam alert so scanning continues while the side panel is closed.

const CONFIG_KEY = "kindred.config";
const DEFAULT_ASSISTANT_MODEL = "gpt-5-mini";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const pendingScans = new Map();
const scanGenerations = new Map();
const SCAN_STATUS_PREFIX = "kindred.scam-status.";
const MAX_SCAN_MS = 8500;

console.log("[Kindred] service worker started");

if (chrome.sidePanel && chrome.sidePanel.setOptions) {
  chrome.sidePanel.setOptions({ path: "src/sidepanel/sidepanel.html", enabled: true }).catch(console.error);
}
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  }
});

function getConfig() {
  return new Promise((resolve) => chrome.storage.local.get(CONFIG_KEY, (r) => resolve(r[CONFIG_KEY] || {})));
}

function extractScannablePage() {
  const text = (document.body?.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { url: location.href, title: document.title, text: text.slice(0, 7000) };
}

async function publishScamStatus(tabId, scan) {
  const payload = { ...scan, updatedAt: Date.now() };
  await chrome.storage.session.set({ [SCAN_STATUS_PREFIX + tabId]: payload }).catch(() => {});
  return chrome.runtime.sendMessage({ type: "KINDRED_SCAM_STATUS", tabId, scan: payload }).catch(() => {});
}

function publishPageActivity(tabId, page = {}) {
  return chrome.runtime.sendMessage({ type: "KINDRED_PAGE_ACTIVITY", tabId, page }).catch(() => {});
}

async function ensurePageWatcher(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/scam-watch.js"],
    });
  } catch {
    // Restricted Chrome pages cannot host a content script.
  }
}

async function postOpenAI(body, apiKey, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("scan-timeout");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  try {
    return await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("scan-timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function scanTab(tabId, generation) {
  const isCurrent = () => scanGenerations.get(tabId) === generation;
  const config = await getConfig();
  if (!isCurrent()) return;
  if (!config.scamAlert || !config.apiKey) {
    await chrome.tabs.sendMessage(tabId, { type: "KINDRED_SCAM_RESULTS", matches: [] }).catch(() => {});
    if (config.scamAlert && isCurrent()) {
      await publishScamStatus(tabId, {
        verdict: "caution",
        findings: [{ level: "warn", text: "Add an OpenAI API key in Settings to start automatic scam checks." }],
        matches: [],
      });
    }
    return;
  }

  let page;
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: extractScannablePage });
    page = result?.result;
  } catch {
    return; // restricted tabs and tabs navigating are intentionally ignored
  }
  if (!page?.text) return;

  const body = {
    model: config.assistantModel || DEFAULT_ASSISTANT_MODEL,
    messages: [
      {
        role: "system",
        content: 'You are a high-precision scam detector. Your job is to flag ONLY clear, deliberate scams (phishing, account-suspension threats, requests to send money or credentials, untraceable-payment demands like gift cards/wire/crypto, fake prize/refund bait, impersonation of banks or officials). Precision matters far more than recall: when in doubt, do NOT flag. Most pages are legitimate — normal marketing, sales urgency ("limited time", "sale ends soon"), required form fields, login pages of real sites, news about scams, and ordinary calls-to-action are NOT scams and must return verdict "safe" with an empty matches array. Only put a phrase in "matches" if you are highly confident that exact phrase is part of an actual scam attempt. Return ONLY JSON: {"verdict":"safe|caution|risk","findings":[{"level":"ok|warn|risk","text":"short plain-language reason"}],"matches":["exact short phrase copied verbatim from the visible page"]}. Use "risk" only for clear scams, "caution" for genuinely ambiguous cases, "safe" otherwise. Copy phrases verbatim; never infer or rewrite. At most 8 matches. Empty matches array when none.',
      },
      { role: "user", content: `URL: ${page.url}\nTitle: ${page.title}\n\nVisible text:\n${page.text}` },
    ],
    response_format: { type: "json_object" },
  };

  let response;
  try {
    const deadline = Date.now() + MAX_SCAN_MS;
    response = await postOpenAI(body, config.apiKey, deadline);
    if (response.status === 400) {
      delete body.response_format;
      response = await postOpenAI(body, config.apiKey, deadline);
    }
  } catch (error) {
    if (isCurrent()) {
      await publishScamStatus(tabId, {
        state: "error",
        verdict: "caution",
        findings: [{ level: "warn", text: error.message === "scan-timeout" ? "Scan took too long. The fast on-page warning still protects obvious scams." : "Automatic scam scan could not connect. Try again shortly." }],
        matches: [],
      });
    }
    return;
  }
  if (!response.ok) {
    if (isCurrent()) {
      await publishScamStatus(tabId, {
        state: "error",
        verdict: "caution",
        findings: [{ level: "warn", text: "Automatic scam scan could not finish. Check your API key and selected model in Settings." }],
        matches: [],
      });
    }
    return;
  }
  if (!isCurrent()) return;

  try {
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    const verdict = ["safe", "caution", "risk"].includes(parsed.verdict)
      ? parsed.verdict
      : "safe";
    // Trust the model's overall judgment: if it cleared the page as safe,
    // don't highlight stray phrases. This keeps the on-page warnings precise.
    const matches = verdict === "safe"
      ? []
      : (Array.isArray(parsed.matches)
          ? parsed.matches.filter((item) => typeof item === "string" && item.length >= 5).slice(0, 8)
          : []);
    const scan = {
      verdict,
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 4) : [],
      matches,
    };
    if (!isCurrent()) return;
    await chrome.tabs.sendMessage(tabId, { type: "KINDRED_SCAM_RESULTS", matches }).catch(() => {});
    await publishScamStatus(tabId, scan);
  } catch (error) {
    console.warn("[Kindred] couldn't parse scam scan", error);
    if (isCurrent()) {
      await publishScamStatus(tabId, {
        state: "error",
        verdict: "caution",
        findings: [{ level: "warn", text: "Automatic scam scan returned an unreadable result. Try another model in Settings." }],
        matches: [],
      });
    }
  }
}

function invalidateScan(tabId) {
  clearTimeout(pendingScans.get(tabId));
  pendingScans.delete(tabId);
  const generation = (scanGenerations.get(tabId) || 0) + 1;
  scanGenerations.set(tabId, generation);
  return generation;
}

function scheduleScan(tabId, delay = 250) {
  if (!Number.isInteger(tabId)) return;
  const generation = invalidateScan(tabId);
  publishScamStatus(tabId, { state: "scanning", matches: [] });
  pendingScans.set(tabId, setTimeout(() => {
    pendingScans.delete(tabId);
    scanTab(tabId, generation).catch((error) => console.warn("[Kindred] scam scan failed", error));
  }, delay));
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message?.type) return;
  if (message.type === "KINDRED_SCAM_SCAN_NOW" && Number.isInteger(message.tabId)) {
    ensurePageWatcher(message.tabId).finally(() => scheduleScan(message.tabId, 50));
    return;
  }
  const tabId = sender.tab?.id;
  if (!tabId) return;
  if (message.type === "KINDRED_SCAM_WATCH_READY" || message.type === "KINDRED_PAGE_CHANGED") {
    invalidateScan(tabId);
    publishPageActivity(tabId, { url: message.url, title: message.title });
    getConfig().then((config) => {
      if (message.type === "KINDRED_SCAM_WATCH_READY") {
        chrome.tabs.sendMessage(tabId, { type: "KINDRED_SCAM_ALERT", enabled: Boolean(config.scamAlert) }).catch(() => {});
      }
      if (config.scamAlert) scheduleScan(tabId);
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") {
    publishPageActivity(tabId, { url: info.url });
    ensurePageWatcher(tabId).finally(() => scheduleScan(tabId, 750));
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(pendingScans.get(tabId));
  pendingScans.delete(tabId);
  scanGenerations.delete(tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[CONFIG_KEY]) return;
  chrome.tabs.query({}).then((tabs) => {
    tabs.forEach((tab) => {
      if (tab.id != null) {
        invalidateScan(tab.id);
        const enabled = Boolean(changes[CONFIG_KEY].newValue?.scamAlert);
        ensurePageWatcher(tab.id).then(() => {
          chrome.tabs.sendMessage(tab.id, { type: "KINDRED_SCAM_ALERT", enabled }).catch(() => {});
          if (enabled) scheduleScan(tab.id, 100);
        });
      }
    });
  });
});
