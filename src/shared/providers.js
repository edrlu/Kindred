/* =========================================================
   Kindred — provider layer (Anthropic / Claude + shared config)

   This is the single home for the new sponsor-track API keys and
   the Claude client that powers Kindred's agentic features
   (Guide Me + Website Autopilot). It shares one config blob with
   the existing OpenAI layer (src/shared/ai.js) under the same
   storage key, so both can coexist:

     kindred.config = {
       // OpenAI (existing — page generation + scam scan)
       apiKey, generationModel, assistantModel, scamAlert,

       // Anthropic — the agent brain (Guide Me + Autopilot)
       anthropicKey, agentModel,

       // Deepgram — speech-to-text (voice commands)
       deepgramKey,

       // ElevenLabs — natural spoken voice (read aloud + guidance)
       elevenLabsKey, voiceId, voiceEnabled,

       // Browserbase — cloud Website Autopilot backend (optional)
       browserbaseKey, browserbaseProjectId, autopilotCloud,

       // Trusted-contact alert email (single designated address)
       resendKey, fromEmail, trustedEmail, trustedName,
     }

   Keys are placeholders until the user adds them in Settings.
   Every track is wired so a feature simply lights up once its key
   is present; nothing here sends data anywhere on its own.
   ========================================================= */

(() => {
  "use strict";

  const STORAGE_KEY = "kindred.config";

  // Defaults — safe to ship without keys.
  const DEFAULTS = {
    agentModel: "claude-opus-4-8",       // most capable; adaptive thinking
    voiceId: "21m00Tcm4TlvDq8ikWAM",     // ElevenLabs "Rachel" — calm, clear
    voiceEnabled: false,
    autopilotCloud: false,
  };

  const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
  const ANTHROPIC_VERSION = "2023-06-01";

  const hasChromeStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  /* ---------- config (shared blob) ---------- */
  async function getConfig() {
    if (hasChromeStorage) {
      return new Promise((resolve) =>
        chrome.storage.local.get(STORAGE_KEY, (r) =>
          resolve(Object.assign({}, DEFAULTS, r[STORAGE_KEY] || {}))
        )
      );
    }
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
    } catch {
      return Object.assign({}, DEFAULTS);
    }
  }

  async function setConfig(patch) {
    // Merge against the raw stored blob (not DEFAULTS) so we never
    // persist defaults as if the user chose them.
    const raw = hasChromeStorage
      ? await new Promise((res) => chrome.storage.local.get(STORAGE_KEY, (r) => res(r[STORAGE_KEY] || {})))
      : (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; } })();
    const merged = Object.assign({}, raw, patch);
    if (hasChromeStorage) {
      return new Promise((resolve) =>
        chrome.storage.local.set({ [STORAGE_KEY]: merged }, () => resolve(merged))
      );
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return merged;
  }

  /* ---------- capability checks ---------- */
  async function status() {
    const c = await getConfig();
    return {
      anthropic: Boolean(c.anthropicKey && c.anthropicKey.trim()),
      openai: Boolean(c.apiKey && c.apiKey.trim()),
      deepgram: Boolean(c.deepgramKey && c.deepgramKey.trim()),
      elevenlabs: Boolean(c.elevenLabsKey && c.elevenLabsKey.trim()),
      browserbase: Boolean(c.browserbaseKey && c.browserbaseKey.trim()),
      resend: Boolean(c.resendKey && c.resendKey.trim()),
      trustedEmail: Boolean(c.trustedEmail && c.trustedEmail.trim()),
    };
  }

  async function hasAnthropic() {
    const c = await getConfig();
    return Boolean(c.anthropicKey && c.anthropicKey.trim());
  }

  /* ---------- Claude (Anthropic Messages API) ----------
     Called directly from the side panel. Anthropic permits this
     from a browser only with the explicit opt-in header below.
     Model defaults to claude-opus-4-8: adaptive-thinking only, and
     it rejects temperature / top_p / budget_tokens — so we never
     send them. */
  async function claude(messages, opts = {}) {
    const cfg = await getConfig();
    const apiKey = cfg.anthropicKey;
    if (!apiKey || !apiKey.trim()) {
      throw new Error("No Anthropic API key set. Add one in Settings to use Kindred's AI guide.");
    }
    const model = opts.model || cfg.agentModel || DEFAULTS.agentModel;

    const body = {
      model,
      max_tokens: opts.maxTokens || 2000,
      messages,
    };
    if (opts.system) body.system = opts.system;
    // Adaptive thinking is opt-in and adds latency; leave it off for
    // snappy, interactive use unless a caller explicitly asks.
    if (opts.thinking) body.thinking = { type: "adaptive" };

    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 401) throw new Error("Anthropic key was rejected. Check it in Settings.");
      if (res.status === 404) throw new Error(`Model "${model}" isn't available on this key. Pick another in Settings.`);
      if (res.status === 429) throw new Error("Claude is rate limited or out of quota. Try again shortly.");
      throw new Error(`Claude request failed (${res.status}). ${detail}`.trim());
    }

    const data = await res.json();
    // content is an array of blocks; concatenate the text blocks.
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b && b.type === "text").map((b) => b.text).join("")
      : "";
    return text;
  }

  /** Like claude(), but coaxes and parses JSON (tolerates code fences/prose). */
  async function claudeJSON(messages, opts = {}) {
    const sys = (opts.system ? opts.system + "\n\n" : "") +
      "Respond with a single valid JSON object and nothing else. No prose, no markdown fences.";
    const raw = await claude(messages, Object.assign({}, opts, { system: sys }));
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* fall through */ }
      }
      throw new Error("Couldn't read Claude's response.");
    }
  }

  window.KindredProviders = {
    getConfig, setConfig, status, hasAnthropic,
    claude, claudeJSON, DEFAULTS,
  };
})();
