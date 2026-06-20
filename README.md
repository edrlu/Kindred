# Kindred

**An AI-powered accessibility layer for the web.**

Kindred is a Chrome extension that lets anyone reshape any website into a
simpler, safer, and more personalized version using plain language. It opens as
a calm right-side sidebar — never replacing or blocking the page — and helps
people enlarge text, remove confusing UI, understand buttons, detect scams,
simplify pages, and get guided step-by-step through online tasks.

> **Status:** Design-only UI prototype. This repository contains the polished
> front-end skeleton. There is no backend or AI functionality wired up yet —
> all content is placeholder/dummy state.

---

## What's in the prototype

The side panel (≈360–420px wide) includes:

- **Header** — Kindred wordmark, live status (“Ready to adapt this page”), settings.
- **Primary action card** — *Simplify this page*.
- **Quick actions** — Explain page · Guide me · Read aloud · Check safety ·
  Improve readability · Customize view.
- **Current page summary** — placeholder summary card with loading skeleton.
- **Safety insights** — placeholder card for scam warnings & risky buttons.
- **Guided next step** — a recommended-action card with step progress.
- **Natural-language composer** — “How should I adapt this page for you?” with
  suggested-prompt chips.

---

## Project structure

```
.
├── manifest.json                # MV3 manifest (side panel + action)
├── assets/
│   └── icons/                   # Brand icons (16/32/48/128)
├── src/
│   ├── background/
│   │   └── service-worker.js    # Opens the side panel on toolbar click
│   └── sidepanel/
│       ├── sidepanel.html       # Side panel markup (semantic + a11y)
│       ├── sidepanel.css        # Design system + components
│       └── sidepanel.js         # Light prototype interactions only
└── README.md
```

---

## Run it locally

1. Open `chrome://extensions` in Chrome (114+).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Pin **Kindred** and click the toolbar icon to open the side panel.

### Preview without Chrome

You can also open the panel directly in a browser tab to iterate on design:

```
open src/sidepanel/sidepanel.html
```

---

## Design language

- Light, calm surfaces with soft shadows and rounded cards.
- Brand gradient: blue `#4F7CFF` → teal `#3BB4A6`.
- Large, readable typography and accessible contrast.
- Accessibility built in: semantic landmarks, ARIA labels, visible focus rings,
  and `prefers-reduced-motion` support.

All theming lives in CSS custom properties at the top of
`src/sidepanel/sidepanel.css`.
