# Kindred — Current Features

- **Simplify page** — applies a calmer reading view to the current page.
- **Readability** — toggles the reading view on and off.
- **Safety check** — manually analyzes the current page for scam and phishing risks.
- **Scam alert** — continuously watches for page changes, flags obvious scam language locally, and adds deeper AI checks with on-page labels.
- **Natural-language page changes** — use the prompt box to request page styling, hiding, interactions, or data extraction.
- **Data extraction** — turns repeated page content into a sortable, filterable, exportable table.
- **Settings** — securely stores the API key, Scam alert preference, and separate models for page generation versus safety/assistance.

## New: AI agent + voice features (hackathon tracks)

Each lights up once its key is added in Settings. Until then the buttons show a friendly "add a key" prompt.

- **Guide me** *(Anthropic / Claude)* — ask for a destination ("How do I buy this on Amazon?"); Claude plans the steps and an animated on-page cursor + large tooltips point you through it, one step at a time. Advances when you do the action or press "I did it — next step."
- **Do it for me / Website Autopilot** *(Anthropic / Claude, optional Browserbase)* — Claude reads the page and completes the task itself, one safe step at a time. A status banner with a big **STOP** button stays on the page, and Kindred pauses for your **confirmation** before anything that spends money, submits, or sends.
- **Voice control** *(Deepgram, falls back to the browser)* — tap the microphone in the composer or task box to speak your request instead of typing.
- **Read aloud / spoken guidance** *(ElevenLabs, falls back to the browser)* — reads the page or speaks guidance in a warm, natural voice. Toggle "Speak replies aloud" in Settings.
- **Tell my contact** *(Resend)* — sends a short, calm alert to **one** designated trusted-contact email (a family member or caregiver). Rate-limited to one message per 30 seconds — it is deliberately not a bulk mailer.

### Which key powers what (add in Settings → test tomorrow)
- **Anthropic** key → Guide me + Autopilot (set the model: Opus 4.8 / Sonnet 4.6 / Haiku 4.5).
- **Deepgram** key → speak-to-type (mic). Works without a key via the browser's speech engine in Chrome.
- **ElevenLabs** key (+ optional voice ID) → natural read-aloud / spoken guidance. Works without a key via the browser voice.
- **Browserbase** key + project ID → optional cloud Autopilot backend (key is wired; in-browser Autopilot is the default).
- **Resend** key + **Trusted contact email** → the "Tell my contact" alert.
