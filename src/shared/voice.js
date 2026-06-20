/* =========================================================
   Kindred — voice layer (speech in + spoken voice out)

   Two sponsor-track APIs power Kindred's hands-free experience,
   each with a built-in browser fallback so the feature still works
   with no keys at all:

     • Deepgram   — speech-to-text  (listening to the user)
                    fallback: Web Speech API (SpeechRecognition)
     • ElevenLabs — text-to-speech  (Kindred speaking back / read-aloud)
                    fallback: window.speechSynthesis

   Keys are read at runtime from window.KindredProviders.getConfig()
   (defined in src/shared/providers.js, loaded before this file):
     { deepgramKey, elevenLabsKey, voiceId, voiceEnabled }

   Nothing here sends data anywhere until a feature explicitly calls
   speak() or listen(). listen() requires microphone permission.
   ========================================================= */

(() => {
  "use strict";

  /* ElevenLabs defaults — "Rachel": calm, clear, friendly. */
  const ELEVEN_TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech/";
  const ELEVEN_MODEL = "eleven_turbo_v2_5";
  const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

  /* Deepgram realtime endpoint — tuned for conversational accuracy. */
  const DEEPGRAM_WS =
    "wss://api.deepgram.com/v1/listen" +
    "?model=nova-2&smart_format=true&interim_results=true&punctuate=true";

  /* ---------- module-level playback state ----------
     We never allow two voices at once: starting a new speak() or
     calling stopSpeaking() tears down whatever was playing. */
  let currentAudio = null;       // HTMLAudioElement (ElevenLabs path)
  let currentAudioUrl = null;    // object URL to revoke when done
  let currentUtterance = null;   // SpeechSynthesisUtterance (fallback path)

  /* ---------- helpers ---------- */

  /** Read config defensively — never throw if providers.js is missing. */
  async function readConfig() {
    try {
      if (window.KindredProviders && typeof window.KindredProviders.getConfig === "function") {
        return (await window.KindredProviders.getConfig()) || {};
      }
    } catch {
      /* fall through to empty config */
    }
    return {};
  }

  const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

  /** The browser's SpeechRecognition constructor, if any. */
  function getSpeechRecognition() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  /* ---------- capabilities ---------- */

  /**
   * Report what's available right now, given the current config + browser.
   * @returns {Promise<{stt:boolean, tts:boolean,
   *   sttProvider:"deepgram"|"webspeech"|"none",
   *   ttsProvider:"elevenlabs"|"webspeech"|"none"}>}
   */
  async function capabilities() {
    const cfg = await readConfig();
    const hasDeepgram = nonEmpty(cfg.deepgramKey);
    const hasEleven = nonEmpty(cfg.elevenLabsKey);
    const hasWebSpeechIn = Boolean(getSpeechRecognition());
    const hasWebSpeechOut = typeof window.speechSynthesis !== "undefined";

    const sttProvider = hasDeepgram ? "deepgram" : hasWebSpeechIn ? "webspeech" : "none";
    const ttsProvider = hasEleven ? "elevenlabs" : hasWebSpeechOut ? "webspeech" : "none";

    return {
      stt: sttProvider !== "none",
      tts: ttsProvider !== "none",
      sttProvider,
      ttsProvider,
    };
  }

  /* =======================================================
     TEXT-TO-SPEECH  (Kindred speaking)
     ======================================================= */

  /** Tear down any in-flight Audio element + its object URL. */
  function teardownAudio() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch { /* ignore */ }
      currentAudio.src = "";
      currentAudio = null;
    }
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch { /* ignore */ }
      currentAudioUrl = null;
    }
  }

  /** Stop any current playback immediately (both paths). */
  function stopSpeaking() {
    teardownAudio();
    currentUtterance = null;
    if (typeof window.speechSynthesis !== "undefined") {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
  }

  /**
   * Speak `text` aloud. Resolves when playback finishes, rejects on error.
   * Prefers ElevenLabs when a key is set; otherwise uses the browser voice.
   * @param {string} text
   * @param {{signal?:AbortSignal}} [opts]
   * @returns {Promise<void>}
   */
  async function speak(text, opts = {}) {
    const phrase = String(text == null ? "" : text).trim();
    if (!phrase) return; // nothing to say

    // Never overlap voices — cancel whatever is currently playing.
    stopSpeaking();

    // Honor an already-aborted signal up front.
    if (opts.signal && opts.signal.aborted) return;

    const cfg = await readConfig();

    if (nonEmpty(cfg.elevenLabsKey)) {
      try {
        return await speakElevenLabs(phrase, cfg, opts);
      } catch (err) {
        // If the network/API path fails, try not to leave the user in
        // silence — fall back to the browser voice when possible.
        if (typeof window.speechSynthesis !== "undefined") {
          return speakWebSpeech(phrase, opts);
        }
        throw err;
      }
    }

    if (typeof window.speechSynthesis !== "undefined") {
      return speakWebSpeech(phrase, opts);
    }

    throw new Error("Speaking isn't available on this device.");
  }

  /** ElevenLabs path: fetch audio/mpeg, play it, resolve on `ended`. */
  async function speakElevenLabs(phrase, cfg, opts) {
    const voiceId = nonEmpty(cfg.voiceId) ? cfg.voiceId.trim() : DEFAULT_VOICE_ID;
    const res = await fetch(ELEVEN_TTS_BASE + encodeURIComponent(voiceId), {
      method: "POST",
      headers: {
        "xi-api-key": cfg.elevenLabsKey.trim(),
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text: phrase, model_id: ELEVEN_MODEL }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 401) throw new Error("ElevenLabs key was rejected. Check it in Settings.");
      if (res.status === 429) throw new Error("ElevenLabs is rate limited or out of quota.");
      throw new Error(`ElevenLabs request failed (${res.status}). ${detail}`.trim());
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    // Register as current so stopSpeaking()/a new speak() can cancel it.
    currentAudio = audio;
    currentAudioUrl = url;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        // Only tear down if this audio is still the active one.
        if (currentAudio === audio) teardownAudio();
      };
      const onEnded = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Couldn't play the spoken audio."));
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(); // aborting is a normal stop, not a failure
      };

      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      if (opts.signal) opts.signal.addEventListener("abort", onAbort);

      audio.play().catch(onError);
    });
  }

  /** Browser fallback: SpeechSynthesisUtterance with a calm English voice. */
  function speakWebSpeech(phrase, opts) {
    return new Promise((resolve, reject) => {
      const synth = window.speechSynthesis;
      const utter = new SpeechSynthesisUtterance(phrase);
      utter.rate = 0.95; // a touch slower — easier to follow
      utter.pitch = 1.0;

      // Prefer an English voice if the list is ready.
      try {
        const voices = synth.getVoices() || [];
        const en =
          voices.find((v) => /^en[-_]US/i.test(v.lang)) ||
          voices.find((v) => /^en/i.test(v.lang));
        if (en) utter.voice = en;
      } catch {
        /* voice list not ready — default voice is fine */
      }

      currentUtterance = utter;

      let settled = false;
      const cleanup = () => {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        if (currentUtterance === utter) currentUtterance = null;
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        // A cancel() also fires 'error' as "interrupted"/"canceled";
        // treat a deliberate abort as a clean stop.
        resolve();
      };
      const onAbort = () => {
        try { synth.cancel(); } catch { /* ignore */ }
        onEnd();
      };

      utter.addEventListener("end", onEnd);
      utter.addEventListener("error", onError);
      if (opts.signal) {
        if (opts.signal.aborted) { onAbort(); return; }
        opts.signal.addEventListener("abort", onAbort);
      }

      try {
        synth.speak(utter);
      } catch (e) {
        settled = true;
        cleanup();
        reject(e instanceof Error ? e : new Error("Speaking failed."));
      }
    });
  }

  /* =======================================================
     SPEECH-TO-TEXT  (listening to the user)
     ======================================================= */

  /**
   * Start capturing the microphone. Resolves quickly (once listening has
   * begun) to a controller: { stop() }. Transcripts arrive via callbacks.
   * @param {{
   *   onPartial?:(text:string)=>void,
   *   onFinal?:(text:string)=>void,
   *   onError?:(err:Error)=>void,
   *   onStart?:()=>void,
   *   onStop?:()=>void
   * }} [opts]
   * @returns {Promise<{stop:()=>void}>}
   */
  async function listen(opts = {}) {
    const cb = {
      onPartial: opts.onPartial || (() => {}),
      onFinal: opts.onFinal || (() => {}),
      onError: opts.onError || (() => {}),
      onStart: opts.onStart || (() => {}),
      onStop: opts.onStop || (() => {}),
    };

    const cfg = await readConfig();

    // Preferred: Deepgram realtime streaming.
    if (nonEmpty(cfg.deepgramKey)) {
      try {
        return await listenDeepgram(cfg.deepgramKey.trim(), cb);
      } catch (err) {
        // Surface a friendly reason, then fall through to a browser path
        // if one exists (e.g. mic worked but socket failed).
        cb.onError(toFriendlyError(err));
        if (getSpeechRecognition()) return listenWebSpeech(cb);
        return noopController(cb);
      }
    }

    // Fallback: Web Speech API.
    if (getSpeechRecognition()) {
      return listenWebSpeech(cb);
    }

    // Nothing available.
    cb.onError(new Error("Voice input isn't available."));
    return noopController(cb);
  }

  /** Turn a raw error into a user-friendly one (esp. mic permission). */
  function toFriendlyError(err) {
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return new Error("Microphone permission was blocked.");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return new Error("No microphone was found.");
    }
    return err instanceof Error ? err : new Error("Couldn't start listening.");
  }

  /** A controller that does nothing but still fires onStop() once. */
  function noopController(cb) {
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        try { cb.onStop(); } catch { /* ignore */ }
      },
    };
  }

  /* ---------- Deepgram realtime path ---------- */
  async function listenDeepgram(deepgramKey, cb) {
    // 1) Microphone — wrap so permission errors surface kindly.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw toFriendlyError(err);
    }

    const stopTracks = () => {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch { /* ignore */ }
    };

    // 2) Open the Deepgram socket. The key travels as a WS subprotocol.
    let ws;
    try {
      ws = new WebSocket(DEEPGRAM_WS, ["token", deepgramKey]);
    } catch (err) {
      stopTracks();
      throw err instanceof Error ? err : new Error("Couldn't connect to Deepgram.");
    }
    ws.binaryType = "arraybuffer";

    // 3) Pick a recorder mime type the browser actually supports.
    let recorder = null;
    const mimeType =
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported &&
      MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch { /* ignore */ }
      stopTracks();
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
        }
      } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      try { cb.onStop(); } catch { /* ignore */ }
    };

    // 4) Wait for the socket to open before we report "listening".
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", () => {
        try {
          recorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);
        } catch (e) {
          reject(e instanceof Error ? e : new Error("Recording isn't supported here."));
          return;
        }

        recorder.addEventListener("dataavailable", (ev) => {
          if (ev.data && ev.data.size > 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(ev.data); // Deepgram accepts the raw audio blob
          }
        });

        // ~250ms chunks: low latency without flooding the socket.
        try {
          recorder.start(250);
        } catch (e) {
          reject(e instanceof Error ? e : new Error("Couldn't start the microphone."));
          return;
        }

        try { cb.onStart(); } catch { /* ignore */ }
        resolve();
      }, { once: true });

      ws.addEventListener("error", () => {
        // If the socket errors before opening, surface it as a failure.
        if (!stopped) reject(new Error("Couldn't connect to Deepgram."));
      });
    });

    // 5) Stream transcripts to the callbacks.
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return; // ignore binary / unparseable frames
      }
      if (!msg || !msg.channel || !Array.isArray(msg.channel.alternatives)) return;
      const transcript = (msg.channel.alternatives[0] || {}).transcript || "";
      if (!transcript) return;
      if (msg.is_final || msg.speech_final) {
        try { cb.onFinal(transcript); } catch { /* ignore */ }
      } else {
        try { cb.onPartial(transcript); } catch { /* ignore */ }
      }
    });

    ws.addEventListener("close", () => { stop(); });

    return { stop };
  }

  /* ---------- Web Speech API fallback ---------- */
  function listenWebSpeech(cb) {
    const Rec = getSpeechRecognition();
    const recognition = new Rec();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    let stopped = false;

    recognition.addEventListener("result", (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const text = (result[0] && result[0].transcript) || "";
        if (result.isFinal) {
          if (text.trim()) { try { cb.onFinal(text.trim()); } catch { /* ignore */ } }
        } else {
          interim += text;
        }
      }
      if (interim.trim()) { try { cb.onPartial(interim.trim()); } catch { /* ignore */ } }
    });

    recognition.addEventListener("error", (ev) => {
      // "aborted"/"no-speech" after a deliberate stop aren't real failures.
      if (stopped) return;
      const code = ev && ev.error;
      let err;
      if (code === "not-allowed" || code === "service-not-allowed") {
        err = new Error("Microphone permission was blocked.");
      } else if (code === "no-speech") {
        err = new Error("I didn't catch that. Please try again.");
      } else {
        err = new Error("Voice input ran into a problem.");
      }
      try { cb.onError(err); } catch { /* ignore */ }
    });

    recognition.addEventListener("end", () => {
      try { cb.onStop(); } catch { /* ignore */ }
    });

    try {
      recognition.start();
      try { cb.onStart(); } catch { /* ignore */ }
    } catch (err) {
      // start() throws if already running — treat as a soft error.
      try { cb.onError(toFriendlyError(err)); } catch { /* ignore */ }
    }

    return {
      stop() {
        if (stopped) return;
        stopped = true;
        try { recognition.stop(); } catch { /* ignore */ }
      },
    };
  }

  /* ---------- public surface ---------- */
  window.KindredVoice = {
    capabilities,
    speak,
    stopSpeaking,
    listen,
  };
})();
