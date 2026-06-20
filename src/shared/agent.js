/* =========================================================
   Kindred — agent orchestrator (Claude brain)

   The thinking half of two features. The on-page halves live in
   content scripts:
     • Guide Me   → src/content/guide.js   (animated cursor + tips)
     • Autopilot  → src/content/autopilot.js (acts on the page)

   This module runs in the side panel. It reads the page through
   those content scripts, asks Claude (via window.KindredProviders)
   for ONE next step at a time, and drives the on-page engine —
   re-reading after every move so it stays correct as the page
   changes. Everything is gated for a vulnerable user: Autopilot
   pauses for confirmation before anything that spends money or
   submits, and a STOP button on the page halts it instantly.
   ========================================================= */

(() => {
  "use strict";

  const P = window.KindredProviders;
  const V = () => window.KindredVoice; // resolved lazily; may be absent

  const RESTRICTED =
    /^(chrome|edge|brave|about|view-source|chrome-extension|moz-extension):|^https:\/\/chrome\.google\.com\/webstore/i;

  /* ---------- tab + content-script plumbing ---------- */
  async function getActiveTab() {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  async function ensureScript(tabId, file) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    } catch {
      // Restricted pages can't host content scripts.
    }
  }

  function send(tabId, msg) {
    return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- one-shot runtime events from content scripts ----------
     guide.js / autopilot.js emit KINDRED_GUIDE_EVENT / KINDRED_AUTOPILOT_EVENT.
     We let callers await the next matching event with a timeout. */
  const waiters = [];
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.type) return;
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(message)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(message);
        }
      }
    });
  }

  function nextEvent(match, timeoutMs) {
    return new Promise((resolve) => {
      const w = { match, resolve };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null); // timed out
      }, timeoutMs);
      waiters.push(w);
    });
  }

  /* ---------- shared run state (so STOP works across features) ---------- */
  let active = null; // { kind, stopped }

  function stop() {
    if (active) active.stopped = true;
  }
  function isRunning() {
    return Boolean(active && !active.stopped);
  }

  async function speak(text, run) {
    try {
      const cfg = await P.getConfig();
      if (!cfg.voiceEnabled || !V() || !text) return;
      await V().speak(text).catch(() => {});
    } catch { /* voice is best-effort */ }
  }

  function elementsToPrompt(els) {
    return (els || [])
      .map((e) => `[${e.id}] <${e.tag}${e.role ? " role=" + e.role : ""}>${e.value ? ' value="' + e.value + '"' : ""} ${e.label}`)
      .join("\n")
      .slice(0, 9000);
  }

  /* =========================================================
     GUIDE ME — point the user through it themselves
     cb: { onLog, onStep, onConfirmAdvance, onDone, onError }
     onConfirmAdvance() resolves when the user clicks "Next" in
     the panel (an alternative to physically doing the action).
     ========================================================= */
  async function guide(goal, cb = {}) {
    const run = { kind: "guide", stopped: false };
    active = run;
    const log = (m) => cb.onLog && cb.onLog(m);

    try {
      const tab = await getActiveTab();
      if (!tab || tab.id == null) throw new Error("No active tab to guide.");
      if (RESTRICTED.test(tab.url || "")) throw new Error("Kindred can't guide on this kind of page.");
      if (!(await P.hasAnthropic())) throw new Error("Add an Anthropic (Claude) API key in Settings to use Guide Me.");

      const history = [];
      const MAX_STEPS = 18;

      for (let step = 1; step <= MAX_STEPS; step++) {
        if (run.stopped) break;

        await ensureScript(tab.id, "src/content/guide.js");
        const scan = await send(tab.id, { type: "KINDRED_GUIDE_SCAN" });
        const els = (scan && scan.elements) || [];

        const decision = await P.claudeJSON(
          [{
            role: "user",
            content:
              `The user's goal: ${goal}\n\n` +
              `Steps already given:\n${history.length ? history.map((h, i) => `${i + 1}. ${h}`).join("\n") : "(none yet)"}\n\n` +
              `Interactive elements on the page right now (id — description):\n${elementsToPrompt(els)}\n\n` +
              `Choose the SINGLE next element the user should interact with to move toward the goal.`,
          }],
          {
            system:
              "You are Kindred, a calm, patient guide for an elderly or less tech-confident person. " +
              "You never act for them — you tell them exactly what to do next, one small step at a time. " +
              'Reply as JSON: {"id": "<element id or null>", "instruction": "<one short friendly sentence>", "say": "<the same, phrased to be read aloud>", "done": <true|false>}. ' +
              "Pick the most obvious single element that advances the goal. Keep instructions concrete (mention the button/field by its visible label and where it is). " +
              "Never instruct them to enter passwords, card numbers, or personal/financial details unless their goal explicitly requires it. " +
              "When the goal is reached or no further on-page step is needed, set done=true, id=null, and put a warm closing line in instruction/say.",
          }
        );

        if (run.stopped) break;

        if (decision.done || !decision.id) {
          await send(tab.id, { type: "KINDRED_GUIDE_CLEAR" });
          const msg = decision.instruction || "All done — you've reached your goal.";
          log("✓ " + msg);
          await speak(decision.say || msg, run);
          cb.onDone && cb.onDone(msg);
          return;
        }

        const pointed = await send(tab.id, {
          type: "KINDRED_GUIDE_POINT",
          id: decision.id,
          instruction: decision.instruction,
          index: step,
          total: null,
          last: false,
        });

        history.push(decision.instruction);
        log(`Step ${step}: ${decision.instruction}`);
        cb.onStep && cb.onStep({ step, instruction: decision.instruction });
        await speak(decision.say || decision.instruction, run);

        if (!pointed || !pointed.ok) {
          // Couldn't place the cursor — show the text instruction and let the
          // user advance manually rather than getting stuck.
          log("(That control moved — follow the written step, then press Next.)");
        }

        // Advance when the user performs the action OR presses "Next".
        const acted = nextEvent(
          (m) => m.type === "KINDRED_GUIDE_EVENT" && m.event === "acted",
          120000
        );
        const next = cb.onConfirmAdvance ? cb.onConfirmAdvance() : Promise.resolve(null);
        await Promise.race([acted, next]);

        if (run.stopped) break;
        await sleep(700); // let any page change settle before re-scanning
      }

      if (!run.stopped) {
        await send(tab.id, { type: "KINDRED_GUIDE_CLEAR" });
        cb.onDone && cb.onDone("That's as far as I can guide for now.");
      }
    } catch (err) {
      cb.onError && cb.onError(err);
    } finally {
      try {
        const tab = await getActiveTab();
        if (tab?.id != null) await send(tab.id, { type: "KINDRED_GUIDE_CLEAR" });
      } catch { /* ignore */ }
      if (active === run) active = null;
    }
  }

  /* =========================================================
     WEBSITE AUTOPILOT — Kindred does it, with the user in control
     cb: { onLog, onAction, onConfirm, onDone, onError }
     onConfirm(say) → Promise<boolean>  (gate for risky actions)
     ========================================================= */
  async function autopilot(task, cb = {}) {
    const run = { kind: "autopilot", stopped: false };
    active = run;
    const log = (m) => cb.onLog && cb.onLog(m);

    let tab;
    try {
      tab = await getActiveTab();
      if (!tab || tab.id == null) throw new Error("No active tab for Autopilot.");
      if (RESTRICTED.test(tab.url || "")) throw new Error("Kindred can't drive this kind of page.");
      if (!(await P.hasAnthropic())) throw new Error("Add an Anthropic (Claude) API key in Settings to use Autopilot.");

      await ensureScript(tab.id, "src/content/autopilot.js");
      await send(tab.id, { type: "KINDRED_AUTOPILOT_STATUS", text: "Getting started…", running: true });

      // Stop button on the page.
      let pageStop = false;
      const stopWatcher = nextEvent(
        (m) => m.type === "KINDRED_AUTOPILOT_EVENT" && m.event === "stop",
        24 * 60 * 60 * 1000
      ).then(() => { pageStop = true; run.stopped = true; });
      void stopWatcher;

      const history = [];
      const MAX_STEPS = 25;

      for (let step = 1; step <= MAX_STEPS; step++) {
        if (run.stopped) break;

        await ensureScript(tab.id, "src/content/autopilot.js");
        const obs = await send(tab.id, { type: "KINDRED_AUTOPILOT_OBSERVE" });
        if (!obs) { log("Couldn't read the page; stopping."); break; }

        const decision = await P.claudeJSON(
          [{
            role: "user",
            content:
              `Task: ${task}\n\n` +
              `Current page: ${obs.title} — ${obs.url}\n\n` +
              `Actions already taken:\n${history.length ? history.map((h, i) => `${i + 1}. ${h}`).join("\n") : "(none yet)"}\n\n` +
              `Interactive elements (id — description):\n${elementsToPrompt(obs.elements)}\n\n` +
              `Page text (truncated):\n${(obs.text || "").slice(0, 2500)}\n\n` +
              `Decide the SINGLE next action.`,
          }],
          {
            system:
              "You are Kindred Autopilot, acting on behalf of an elderly user to complete a task in their browser, carefully and transparently. " +
              'Reply as JSON: {"action": {"type": "click|type|select|scroll|navigate|done", "id": "<element id>", "text": "<for type>", "value": "<for select>", "url": "<for navigate>", "direction": "down|up"}, "say": "<short plain-language sentence about what you are about to do>", "risk": <true|false>, "done": <true|false>}. ' +
              "Take small, safe steps. Set risk=true for anything that spends money, places or confirms an order, submits a payment, sends a message/email, posts content, deletes data, or changes account or security settings. " +
              "Never place a final order, submit a payment, or send a message unless the user's task explicitly asked for it — and even then set risk=true so they confirm. " +
              "When the task is complete, set done=true with action.type 'done' and a friendly summary in say. If you're blocked, set done=true and explain in say.",
          }
        );

        if (run.stopped) break;

        const a = decision.action || {};
        const say = decision.say || "Working…";

        if (decision.done || a.type === "done") {
          await send(tab.id, { type: "KINDRED_AUTOPILOT_STATUS", text: say, running: false });
          log("✓ " + say);
          await speak(say, run);
          cb.onDone && cb.onDone(say);
          return;
        }

        // Safety gate.
        if (decision.risk) {
          await send(tab.id, { type: "KINDRED_AUTOPILOT_STATUS", text: "Waiting for your OK…", running: true });
          const ok = cb.onConfirm ? await cb.onConfirm(say) : false;
          if (run.stopped) break;
          if (!ok) {
            log("✋ You declined: " + say);
            await send(tab.id, { type: "KINDRED_AUTOPILOT_STATUS", text: "Stopped — you declined that step.", running: false });
            cb.onDone && cb.onDone("Stopped at your request.");
            return;
          }
        }

        log(`Step ${step}: ${say}`);
        cb.onAction && cb.onAction({ step, say, action: a });
        await send(tab.id, { type: "KINDRED_AUTOPILOT_STATUS", text: say, running: true });
        await speak(say, run);

        const res = await send(tab.id, { type: "KINDRED_AUTOPILOT_ACT", action: a });
        history.push(say + (res && res.ok ? "" : " (failed)"));

        if (a.type === "navigate") {
          await sleep(1800); // page is loading
        } else {
          await sleep(900);
        }
      }

      if (run.stopped) {
        await send(tab.id, { type: "KINDRED_AUTOPILOT_STATUS", text: "Stopped.", running: false });
        log(pageStop ? "Stopped from the page." : "Stopped.");
        cb.onDone && cb.onDone("Autopilot stopped.");
      } else {
        await send(tab.id, { type: "KINDRED_AUTOPILOT_STATUS", text: "Reached my step limit — pausing.", running: false });
        cb.onDone && cb.onDone("Reached the step limit and paused for safety.");
      }
    } catch (err) {
      cb.onError && cb.onError(err);
      try { if (tab?.id != null) await send(tab.id, { type: "KINDRED_AUTOPILOT_STATUS", text: "Something went wrong — stopped.", running: false }); } catch { /* ignore */ }
    } finally {
      if (active === run) active = null;
    }
  }

  async function clearOverlays() {
    try {
      const tab = await getActiveTab();
      if (tab?.id == null) return;
      await send(tab.id, { type: "KINDRED_GUIDE_CLEAR" });
      await send(tab.id, { type: "KINDRED_AUTOPILOT_CLEAR" });
    } catch { /* ignore */ }
  }

  window.KindredAgent = { guide, autopilot, stop, isRunning, clearOverlays };
})();
