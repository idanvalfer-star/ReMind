# Privacy

ReMind holds your externalised memory. This document says exactly what leaves your device, what
does not, and — where the design has limits — what those limits actually are rather than a
comfortable version of them.

Everything here is verifiable against the code. Where a claim is enforced by a test, the test is
named.

---

## The short version

Your reminders live in IndexedDB on your device. The server exists for one reason: the web has no
way to schedule a local notification, so **something** has to wake your phone at the right moment.
That something is told a random UUID and a timestamp. It is never told what the reminder says.

When the push arrives, the service worker looks the UUID up in your local database and composes the
notification text on your device. The server that caused the notification to appear has no idea
what it says.

---

## What leaves your device

| What | Why it must | What it reveals |
|---|---|---|
| Push endpoint URL | Where to send the push | The push service you use (Apple, Google, Mozilla) and a per-install token |
| `p256dh` and `auth` keys | **Required** to encrypt the payload, per RFC 8291 | Nothing readable; opaque key material |
| Device public key | Verifies that scheduling requests really come from your device | Nothing; the private half never leaves |
| Subscription id | A row handle | Nothing; a random UUID |
| Trigger id | Round-trips as the entire push payload | Nothing; a random UUID |
| Fire time | The cron needs to know when | **A timestamp. See "What this does reveal".** |

That is the complete list. It is enforced structurally: `src/shared/pushProtocol.ts` defines
`ScheduledPush` as exactly `{ triggerId, fireAt }`, and a test in `src/engine/sync.test.ts` asserts
that the object has exactly those two keys — so adding a third breaks the build rather than quietly
breaking this document.

### What never leaves

Reminder text. Event titles. Note bodies. Names. Locations. Your timezone. Your language. Quiet
hours. Your daily cap. Trigger kinds. How many reminders you have. Anything from an `Entry`.

Quiet hours and the daily cap are applied **on your device, before** a reminder is registered, so
the server never learns them — it only ever receives an absolute instant that already satisfies
them.

### Pinned places, specifically

A note pinned to a place stores its coordinates in IndexedDB and **nothing is sent anywhere at all**
— not the coordinates, not the fact that a pin exists.

This is not a promise held in place by careful coding; it is a consequence of the platform. There is
no Geofencing API on the web and no background execution, so arriving somewhere cannot wake your
device. A pin therefore has no fire time, and a trigger with no fire time is never scheduled and
never mirrored to the backend. It is checked only when you open the app yourself.

The one control worth knowing about: reading your position happens **only** when you tap "Pin here",
or when you open the app while something is already pinned *and* you have already granted location
permission. The app never asks for that permission on its own.

### The one exception: destination weather

Packing lists can use a weather forecast, and a forecast has to come from somewhere. **This is the
only request ReMind ever makes to anything other than its own reminder backend**, and it happens only
when you tap "Get the forecast" on a specific trip.

What is sent, to [Open-Meteo](https://open-meteo.com):

1. The destination text you typed, to their geocoder, so it can be turned into coordinates.
2. Those coordinates and the trip's start and end dates, to their forecast endpoint.

Nothing else — no packing list, no purpose, no identifier, no account. Open-Meteo requires no key and
no sign-up, which is why it was chosen: there is nothing to attach the request to you with beyond
your IP address, which any HTTP request reveals.

If you would rather not, do not tap it. Every packing list works without a forecast; it simply omits
the weather-driven lines, and each line it does add is labelled `weather` so you can see exactly what
the forecast changed.

### Search by meaning runs on your device

Semantic search needs an embedding model. Every commercial option is an HTTP call that sends your note
text to somebody else's server, which is the one thing this whole design exists to avoid — so ReMind
downloads a model and runs it locally, in your browser, in WebAssembly.

The consequence is a one-time download of about 130 MB, which is why the feature is **off by default**
and the size is stated on the button before anything starts. After that it works with the radio off.

What is sent when you use it: **nothing.** Not the query, not the note, not the fact that you searched.
The model files come from the public Hugging Face CDN when you enable it, which reveals that you
downloaded a model and nothing about what you do with it. The vectors it produces are stored in
IndexedDB and are excluded from the JSON backup — they are derived data, and a backup should hold what
you wrote rather than megabytes of recomputable floats.

### Sync between devices sends ciphertext

Sync is optional and off until you set a passphrase. When it is on, every record is encrypted **on your
device** with AES-256-GCM before it is sent, using a key derived from your passphrase by PBKDF2-HMAC-SHA256
at 600,000 iterations. The passphrase never leaves your device, in any form. Neither does the key: it is
created as a non-extractable `CryptoKey`, so the browser will not let the app read it out even if asked.

The server holds ciphertext it has no key for. It cannot read a note, and neither can anyone with access
to the database, including whoever runs it.

The trade-off is absolute and worth stating twice: **if you forget the passphrase, the synced copy is
gone.** There is no account, no reset link and no recovery, because a recovery path is exactly the thing
that would let the server read your notes.

The space code you copy to your other device carries only a space id and a salt. It is not a key and not
a password — it is safe to send to yourself in any way you like. The passphrase is the secret, and you
have to carry that yourself.

---

## What this *does* reveal

Three honest caveats. The first two are consequences of using Web Push at all, not of choices that could
have been made differently within it. The third is the price of sync.

### 1. Timing is metadata

The database holds rows saying "this device wants to be nudged at 08:40 on Tuesday". The *content*
is genuinely absent. The *timing* is not.

Someone with access to that database could infer your sleep schedule from when you never schedule
reminders, that you were busy on a particular evening, or roughly how much you rely on the app.
That is real information, and calling this design "zero-knowledge" would be false.

It could be reduced by padding the table with decoy rows. That is not implemented, because it would
consume the free-tier budget to defend against an adversary who already has your Cloudflare account.

### 2. Subscription key material is stored server-side

The original design for this app said the server would receive the endpoint, the trigger id and the
fire time, and **"nothing else"**. That is not implementable. RFC 8291 payload encryption requires
the subscription's `p256dh` and `auth` values on the sending side; without them there is no way to
encrypt a push at all.

They are opaque key material rather than personal data, so the substance of the privacy claim
survives. But the list is longer than "nothing else", and this document says so rather than
repeating a claim the code cannot honour.

There is one design that would have avoided this: sending a push with **no payload**, which needs no
encryption and therefore no keys. It was investigated and rejected — the evidence for payload-less
push being reliable on iOS is thin, and iOS cancels a subscription outright if a service worker
receives a push and shows no notification. On the one platform this app is built for, that risk was
not worth the improvement.

### 3. Sync reveals shape and timing, though not content

Turning sync on puts more rows on the server than push scheduling does, and they carry metadata that
encryption does not hide:

| What the server holds | What it reveals |
|---|---|
| `record_key`, e.g. `entries:<uuid>` | **Which table** a record belongs to — that this is a note rather than a trip — and a stable id |
| `ciphertext` length | Roughly how long the record is. A one-line note and a long one are distinguishable |
| `updated_at` | When you last changed that record. Sent in clear, because the server needs it to reject a stale overwrite |
| `deleted` | That a record was deleted, and when. The row survives as a tombstone so other devices learn about it |
| `revision` | A counter. Reveals how many times you have pushed |
| Device public keys per space | How many devices share a space |

So an observer with the database could tell that you keep about forty notes, that you added two on
Tuesday evening and deleted one on Thursday, and roughly how long each is. They could not tell what any
of them says.

Content is genuinely absent. Shape and rhythm are not, and no amount of encryption at this layer would
change that — hiding them needs padding and decoy traffic, which is not implemented.

---

## Storage, and why backups matter

Your data is in IndexedDB. iOS evicts IndexedDB from home-screen web apps **without warning and
without asking**, particularly when storage is low or the app has gone unused.

There is no server-side copy to restore from. That is the point of the design, and it is also a real
risk to you. So:

- **Export a backup periodically.** Settings → Backup. It is a plain JSON file.
- The app nags you when it has been more than two weeks and you have data worth losing.
- Restoring **replaces** everything on the device rather than merging. Merging two divergent copies
  of a memory graph needs conflict rules this app has no basis for inventing.

A backup deliberately excludes your push registration. It is per-install, and a backup restored onto
another device must not inherit the first device's push subscription — that would send your
reminders to someone else's phone.

---

## Interpretation is local

Date and time parsing is entirely deterministic and runs on your device, in both English and Hebrew.
No LLM, no API key, no network. Capture works with the radio off.

There is a setting, `allowNetworkInterpretation`, which is `false` and which nothing currently
reads. It exists so that if network-based interpretation is ever added, the switch that disables it
predates it.

---

## Notifications, on your terms

Two limits are enforced before a reminder is ever registered, not at delivery:

- **Quiet hours.** A reminder that would land inside them is refused, and you are told, and offered
  the nearest time that works. It is never silently moved to a time you did not choose.
- **A daily cap.** Same behaviour.

Both are decided locally. The server cannot override them because it never learns them.

---

## Known weaknesses

Stated plainly rather than omitted.

- **Endpoint takeover.** `POST /api/subscribe` cannot be authenticated — it is the request that
  establishes the signing key. So anyone who learns your push endpoint could re-register it with
  their own key and take over your schedule. Endpoints are high-entropy and known only to your
  device and the Worker, and the overwrite has to be allowed so that a device which lost its
  IndexedDB can recover. The tradeoff is deliberate.
- **The Worker operator can see everything the Worker sees.** That is you. This app assumes you
  deploy it to your own Cloudflare account. Hosted for you by someone else, the timing metadata
  above is theirs.
- **No transport-level anonymity.** Cloudflare sees your IP address when your device talks to the
  Worker, as with any HTTPS request.
- **A private event still produces a notification.** Marking an event private keeps its title off
  the notification — the text is replaced, not shortened — but the fact that *something* is
  happening is still visible on your lock screen.
- **Sync trusts the passphrase and nothing else.** Anyone who learns your passphrase *and* your space
  code can read everything in that space. There is no second factor and no way to revoke a device that
  already holds both, short of everyone moving to a new space with a new passphrase.
- **The server could withhold or reorder records.** It cannot read or forge them — a tampered ciphertext
  fails to decrypt, and the record key is authenticated — but it could serve a stale set, or drop a
  record so one device never learns about it. Detecting that needs a signed log per device, which is not
  implemented.

---

## Verifying any of this yourself

The strongest check is to look at the database directly:

```bash
npx wrangler d1 execute remind-push --remote \
  --command "select * from scheduled_pushes limit 20"
```

Every row should contain nothing but UUIDs and integers. If you ever see text in there, this
document is wrong and something is broken.

If you turn sync on, the same check applies to what it stores:

```bash
npx wrangler d1 execute remind-push --remote \
  --command "select record_key, length(ciphertext), iv, deleted from sync_records limit 20"
```

`record_key` is readable by design — it is `entries:<uuid>`, the table name and an id, as the table in
"What this does reveal" says. Everything else should be opaque base64url. A note you can read in that
output would mean the encryption is not happening.

The wire can be checked too, without trusting either document:

```bash
npx wrangler dev --port 8787 --local
SYNC_E2E=1 npx vitest run src/sync/e2e.test.ts
```

One of those tests captures every request body the client sends while syncing a note containing a
distinctive string, and asserts the string appears in none of them.
