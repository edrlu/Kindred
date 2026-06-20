/* =========================================================
   Kindred — shared AI layer
   Single source of truth for the API key + model settings, and the
   one client every AI feature calls. Reads config saved by
   the Settings panel (chrome.storage.local, with a
   localStorage fallback so it also works outside the
   extension, e.g. in a plain browser preview).
   ========================================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "kindred.config";
  const DEFAULT_MODEL = "gpt-5";
  const ENDPOINT = "https://api.openai.com/v1/chat/completions";

  const hasChromeStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  /** Read the saved config: { apiKey, generationModel, assistantModel }. */
  async function getConfig() {
    if (hasChromeStorage) {
      return new Promise((resolve) =>
        chrome.storage.local.get(STORAGE_KEY, (r) => resolve(r[STORAGE_KEY] || {}))
      );
    }
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  /** Merge-and-save config. */
  async function setConfig(patch) {
    const merged = Object.assign({}, await getConfig(), patch);
    if (hasChromeStorage) {
      return new Promise((resolve) =>
        chrome.storage.local.set({ [STORAGE_KEY]: merged }, () => resolve(merged))
      );
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return merged;
  }

  /** True once the user has saved a key. */
  async function isConfigured() {
    const { apiKey } = await getConfig();
    return Boolean(apiKey && apiKey.trim());
  }

  /**
   * The one call every AI feature uses.
   * @param {Array<{role:string, content:string}>} messages
   * @param {{model?:string, temperature?:number, signal?:AbortSignal}} [opts]
   * @returns {Promise<string>} the assistant's reply text
   */
  async function complete(messages, opts = {}) {
    const { apiKey, model } = await getConfig();
    if (!apiKey) {
      throw new Error("No API key set. Add one in Settings.");
    }
    const useModel = opts.model || model || DEFAULT_MODEL;

    // Build the request body. Newer flagship / reasoning models (gpt-5,
    // o-series) reject a custom temperature and use different fields, so we
    // start with the full body and strip unsupported params on a 400 retry.
    const body = { model: useModel, messages };
    if (opts.temperature !== null) body.temperature = opts.temperature ?? 0.3;
    if (opts.json) body.response_format = { type: "json_object" };

    const post = (b) =>
      fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(b),
        signal: opts.signal,
      });

    let res = await post(body);

    // Retry once, dropping whichever param the model complained about.
    if (res.status === 400) {
      const detail = await res.text().catch(() => "");
      if (/temperature|response_format|unsupported|unrecognized|not supported/i.test(detail)) {
        if (/temperature/i.test(detail)) delete body.temperature;
        if (/response_format/i.test(detail)) delete body.response_format;
        else if (!/temperature/i.test(detail)) delete body.temperature; // generic fallback
        res = await post(body);
      } else {
        throw new Error(`OpenAI request failed (400). ${detail}`.trim());
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Surface a friendlier message for the most common failures.
      if (res.status === 401) throw new Error("API key was rejected. Check it in Settings.");
      if (res.status === 404) {
        throw new Error(`Model "${useModel}" isn't available on this API key. Pick another in Settings.`);
      }
      if (res.status === 429) throw new Error("Rate limit or quota reached. Try again shortly.");
      throw new Error(`OpenAI request failed (${res.status}). ${detail}`.trim());
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  /** Like complete(), but asks for JSON and parses it (tolerates code fences). */
  async function completeJSON(messages, opts = {}) {
    const raw = await complete(messages, { ...opts, json: true });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      // Last resort: pull the first {...} block out of the response.
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error("Couldn't read the AI response.");
    }
  }

  window.KindredAI = {
    getConfig, setConfig, isConfigured, complete, completeJSON, DEFAULT_MODEL,
  };
})();
