# ReMind

A proactive personal memory assistant. Installable PWA, local-first, zero infrastructure cost.

Memory does not fail because things were never written down — it fails because the right fragment
does not arrive at the right moment. ReMind is not a storage app; it is a *resurfacing* app. Capture
is deliberately cheap, and everything else exists to deliver the right thing at the right time.

Your data lives in IndexedDB on your device. The push backend is told a random UUID and a timestamp
and nothing else — see [PRIVACY.md](./PRIVACY.md), which also states the limits of that claim
honestly.

---

## Status

**Phase 1.** Capture, calendar, the resurfacing engine, the push pipeline, deterministic
English/Hebrew parsing, search, backup, and the iOS install flow.

Verified: 345 tests, `tsc` clean across four project configs, `eslint` clean, and the production
build produces a working service worker.

**Not yet verified end to end on a device.** Everything below the UI is covered by tests, and the
push crypto is checked byte-for-byte against the reference implementation, but no real iPhone has
installed this and received a real push. That gap closes on your first deploy, not before.

Out of scope for Phase 1, by design: the People and Facts module, trips and packing, spaced
repetition, semantic search, OCR, and any LLM-based interpretation.

---

## How it works

```
capture ──▶ Entry (always saved first, never lost)
              │
              ├──▶ deterministic parse (EN + HE, on-device, offline)
              │       ├─ confident  ──▶ Event created silently, undo offered
              │       └─ uncertain  ──▶ proposal, you confirm
              │
              └──▶ Trigger ──▶ engine: quiet hours + daily cap
                                 │
                                 └──▶ backend: { triggerId, fireAt }
                                          │
                                     cron, once a minute
                                          │
                                        push ─── payload is one UUID
                                          │
                                   service worker
                                          │
                            local lookup, text composed on-device
                                          │
                                     notification
```

The one rule that shapes everything: **IndexedDB is authoritative.** Every network call is
best-effort, a failed request never rolls back local state, and reconciliation on app open repairs
any drift.

---

## Local development

```bash
npm install
npm test          # engine and parser suites
npm run dev       # SPA on :5173
```

The service worker is built in dev too, so install and notification behaviour can be exercised
locally — though iOS push specifically requires a real HTTPS deploy and a home-screen install.

To exercise the API and the cron together, build first and run the Worker:

```bash
npm run build
npm run worker:dev                    # serves dist/ plus /api/*
npx wrangler dev --test-scheduled     # then curl /__scheduled to fire the cron
```

---

## Deploying

Everything is free tier. One Worker serves the SPA, the API and the cron — Cloudflare Pages cannot
host Cron Triggers, so the alternative would have been two deploys on two origins plus CORS.

### 1. Create the database

```bash
npx wrangler d1 create remind-push
```

Copy the printed `database_id` into `wrangler.toml`, replacing `REPLACE_ME`.

> Run this from a writable directory. PowerShell starts in `C:\Windows\System32`, where wrangler
> cannot create its cache — `cd $HOME` first.

### 2. Apply the schema

```bash
npm run db:init          # local
npm run db:init:remote   # deployed
```

### 3. Generate VAPID keys

```bash
npm run vapid:generate
```

Two halves, handled very differently:

- The **public** key goes in `wrangler.toml` under `[vars]` as `VAPID_PUBLIC_KEY`. It is not a
  secret — it is handed to the browser at subscribe time. The client reads it from
  `GET /api/vapid-public-key` so it lives in exactly one place.
- The **private** key signs every push. Anyone holding it can send notifications to every subscribed
  device. It goes in a Worker secret and nowhere else — never in `wrangler.toml`, never in a file,
  never pasted into a chat.

Set `VAPID_SUBJECT` to a real `mailto:` or `https:` URL you control. Push services use it to reach
you if the app misbehaves, and some reject obviously fake values.

### 4. Build and deploy

```bash
npm run build
npm run worker:deploy
```

### 5. Store the private key

Secrets can only be set on a Worker that exists, so this comes **after** the first deploy:

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

For local development put it in `.dev.vars` instead, which is gitignored.

---

## Installing on iPhone

The order matters, and getting it wrong costs you the notification permission prompt permanently.

1. Open the deployed URL in **Safari** (not Chrome — only Safari can install to the home screen).
2. Share → **Add to Home Screen**.
3. Open ReMind **from the home screen**, not from Safari.
4. Settings → **Turn on reminders**.

Step 3 is not optional. Web Push does not exist on iOS until the app is running standalone, and
requesting notification permission from a browser tab burns the prompt — after which it can only be
restored through iOS Settings. The app detects this and shows install instructions instead of a
button that would fail.

Without notifications ReMind still captures and still shows reminders in the app. It simply cannot
interrupt you. The install sheet says so outright rather than letting you find out.

---

## Layout

```
src/
  db/          Dexie schema — the source of truth. Tokenizer for search.
  engine/      The resurfacing engine. Timezone maths, quiet hours, the daily cap,
               trigger evaluation, the notification composer, backend sync.
               Nothing else may schedule a push.
  parse/       Deterministic EN + HE date grammars and confidence scoring.
               Lazy-loaded: chrono is the largest dependency and is only needed on submit.
  capture/     Turning text into an Entry, and possibly an Event.
  calendar/    Month grid geometry, overlap queries, datetime-input conversion.
  search/      Keyword search over the multiEntry index.
  backup/      JSON export and import.
  install/     iOS install detection and the push permission sequence.
  i18n/        One set of resources, read two ways — i18next for the app, a small
               lookup for the service worker.
  components/  React. Thin on purpose; the logic is tested elsewhere.
  sw.ts        Service worker. Composes notification text on-device.
worker/        The push backend. D1 schema, signed API, cron, RFC 8291 encryption.
src/shared/    The wire protocol, imported by both sides so it cannot drift.
```

Four TypeScript project configs, because there are genuinely four runtimes: the app (DOM), the
service worker (WebWorker), the Worker (Cloudflare), and node for tooling. Each one rejects globals
that do not exist in it, which is how shared code stays honest about what it may use.

---

## Notes on the design

[DECISIONS.md](./DECISIONS.md) records the choices and the reasoning, including a reversal left in
place rather than edited out. A few worth knowing up front:

- **Quiet hours and the daily cap suppress, they do not shift.** A reminder arriving at 07:00 when
  you asked for 22:30 is a notification you did not ask for at a time you did not choose. You are
  told why and offered the nearest time that works.
- **"Dinner at 8" means 20:00.** Hour resolution works from an explicit meridiem, to a day-part
  word, to a meal word implying a time of day, to a flagged guess.
- **Hebrew is a hand-written grammar.** `chrono-node` has no Hebrew locale, and particles bind to
  words, `\b` does not work on Hebrew letters, and hours are spelled out in the feminine.
- **The push encryption is hand-written and diffed against the reference implementation** rather
  than taken from a library that bundles a JWT verifier it does not need.
