# Kindred

**An AI-powered accessibility and safety layer for the web.**

Kindred is a Chrome side-panel extension that adapts the current website using plain language. It helps people make pages easier to read, understand a task one step at a time, automate routine actions with confirmation gates, identify potential scams, use voice instead of a keyboard, and share a concise alert with a trusted contact.

It stays alongside the page rather than replacing it, and applies changes directly to the active tab.

## Features

### Page adaptation

- **Simplify this page** — applies a calmer reading view to the active page.
- **Readability mode** — toggles an easier-to-read view, including larger text, reduced clutter, and high-contrast options.
- **Natural-language page changes** — ask Kindred to change the page in plain language, such as hiding distractions, enlarging content, changing contrast, or restructuring a view.
- **Per-site saved views** — saves adaptation recipes per domain and reapplies them when you return.
- **Data extraction** — turns repeated page content into an on-page table that can be sorted, filtered, and exported as CSV.

### Safety

- **Safety check** — runs an on-demand AI review for scams, phishing, dark patterns, hidden costs, recurring charges, fake urgency, and sensitive-information requests.
- **Scam alert** — watches for page changes, detects obvious risky language locally, requests deeper AI analysis when configured, and highlights relevant page text.
- **Clear, plain-language results** — presents a safe/caution/risk verdict with short, actionable findings.

### Guided help and Autopilot

- **Guide me** — Claude reads the current page and gives one small next step at a time, with an animated on-page cursor and large instruction tooltip. The user can perform the action or choose “I did it — next step.”
- **Do it for me / Autopilot** — Claude completes a task one cautious action at a time in the current tab.
- **Confirmation before consequential actions** — Autopilot pauses before actions such as spending money, submitting payment, sending messages, deleting data, or changing account/security settings.
- **Always-available stop controls** — both Guide and Autopilot can be stopped from the side panel; local Autopilot also shows an on-page status banner and STOP control.
- **Optional cloud Autopilot** — Browserbase can provide a cloud-browser execution path; local in-tab Autopilot is the default.

### Voice and trusted-contact support

- **Voice input** — speak requests in the composer or task prompt through Deepgram, with the browser speech-recognition API as a fallback.
- **Read aloud and spoken guidance** — uses ElevenLabs when configured, with browser speech synthesis as a fallback; spoken replies can be enabled in Settings.
- **Tell my contact** — sends a short alert to one configured trusted-contact address via Resend. Messages are rate-limited to one every 30 seconds.

### Accessibility and experience

- Calm, high-contrast visual design with large readable type and visible focus states.
- Semantic landmarks, ARIA labels, keyboard-friendly controls, and `prefers-reduced-motion` support.
- A persistent Chrome side panel, so the original website remains visible and usable.

## Stack

| Layer | Technology |
| --- | --- |
| Extension platform | Chrome Extension Manifest V3; Side Panel API; service worker; content scripts |
| UI | Vanilla HTML, CSS, and JavaScript — no build step or framework required |
| Page integration | `chrome.scripting`, `chrome.tabs`, `activeTab`, and isolated-world content scripts |
| Local persistence | `chrome.storage.local` for settings and saved site views; `chrome.storage.session` for per-tab scan status |
| Page-adaptation AI | OpenAI Chat Completions API (configurable generation and safety models) |
| Guide and Autopilot AI | Anthropic Messages API / Claude (configurable Opus, Sonnet, or Haiku model) |
| Speech-to-text | Deepgram streaming API, with the Web Speech API fallback |
| Text-to-speech | ElevenLabs Text-to-Speech API, with the Web Speech API fallback |
| Optional cloud automation | Browserbase sessions and Chrome DevTools Protocol |
| Trusted-contact email | Resend API |

All API keys and preferences are stored in the extension’s local Chrome storage. Features that depend on a provider remain unavailable until its relevant key is added in Settings; browser voice fallbacks work when supported by Chrome.

## Project structure

```text
.
├── manifest.json                    # MV3 manifest, permissions, side panel, content script
├── assets/icons/                    # Extension icons
└── src/
    ├── background/service-worker.js # Side-panel setup and automatic scam-scan orchestration
    ├── content/
    │   ├── scam-watch.js            # Local watch, highlighting, and scan-result handling
    │   ├── guide.js                 # On-page guided cursor and instruction overlays
    │   ├── autopilot.js             # Local in-tab Autopilot executor and stop banner
    │   └── autopilot-cloud.js       # Optional Browserbase cloud-browser driver
    ├── shared/
    │   ├── ai.js                    # OpenAI configuration and request helper
    │   ├── providers.js             # Anthropic and shared provider configuration
    │   ├── agent.js                 # Guide and Autopilot orchestration
    │   ├── voice.js                 # Speech input/output providers and fallbacks
    │   └── notify.js                # Trusted-contact email sender
    └── sidepanel/
        ├── sidepanel.html           # Side-panel markup and settings
        ├── sidepanel.css            # Design system and accessible UI styles
        └── sidepanel.js             # Panel interactions and page-adaptation engine
```

## Run locally

1. Open `chrome://extensions` in Chrome 114 or later.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose this repository folder.
4. Pin **Kindred**, open any ordinary webpage, and click the extension icon.
5. Open **Settings** in the side panel to add the API keys for the features you want to use.

There is no package install or build command. The extension runs directly from the source files.

## Provider configuration

| Provider | Enables |
| --- | --- |
| OpenAI | Natural-language adaptations, data extraction, safety checks, and AI-backed scam alerts |
| Anthropic | Guide me and local/cloud Autopilot |
| Deepgram | Streaming speech-to-text; browser speech recognition is the fallback |
| ElevenLabs | Natural-sounding read-aloud and spoken guidance; browser speech synthesis is the fallback |
| Browserbase + project ID | Optional cloud-browser Autopilot |
| Resend + trusted contact email | Tell my contact alerts |

Kindred cannot inject scripts into restricted browser pages, such as Chrome internal pages, extension pages, or the Chrome Web Store.
