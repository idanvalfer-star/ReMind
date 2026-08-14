-- ReMind push backend — the entire server-side data model.
--
-- Every column here is an opaque identifier, key material, or an integer. There are no
-- titles, no bodies, no names, no locations, no timezones, no locales and no trigger kinds.
-- See PRIVACY.md, which also states plainly the two things this *does* reveal: that a
-- device exists, and the times it wants to be nudged.
--
--   npm run db:init          (local)
--   npm run db:init:remote   (deployed)

CREATE TABLE IF NOT EXISTS subscriptions (
  -- Opaque UUID minted by the client. Its own handle for this row.
  id             TEXT PRIMARY KEY,

  -- Where to POST the push. Unique because a browser re-subscribing with the same endpoint
  -- is the same device, and we must update rather than accumulate duplicates.
  endpoint       TEXT NOT NULL UNIQUE,

  -- Subscription key material, required server-side by RFC 8291 to encrypt a payload.
  -- Not user data, but not nothing either: PRIVACY.md says so rather than claiming the
  -- brief's "nothing else" literally.
  p256dh         TEXT NOT NULL,
  auth           TEXT NOT NULL,

  -- The device's ECDSA P-256 public key, as a JWK. Every mutating request must carry a
  -- signature this verifies. The private half never leaves the device.
  device_pubkey  TEXT NOT NULL,

  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,

  -- Consecutive send failures. Lets a dead-but-not-404 endpoint be retired.
  failure_count  INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS scheduled_pushes (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,

  -- Identical to Trigger.id in the client's IndexedDB, and the whole of the push payload.
  -- Meaningless without the device's local database, which is the point.
  trigger_id      TEXT NOT NULL,

  fire_at         INTEGER NOT NULL,   -- UTC epoch ms
  attempts        INTEGER NOT NULL DEFAULT 0,
  sent_at         INTEGER,            -- NULL while pending

  PRIMARY KEY (subscription_id, trigger_id)
) STRICT;

-- The cron's only query: pending rows that are due. Partial, so sent history costs nothing
-- to skip over.
CREATE INDEX IF NOT EXISTS idx_pending_due
  ON scheduled_pushes (fire_at)
  WHERE sent_at IS NULL;

-- Reconcile replaces the pending set for one subscription, so it deletes by that.
CREATE INDEX IF NOT EXISTS idx_pending_by_subscription
  ON scheduled_pushes (subscription_id)
  WHERE sent_at IS NULL;

-- ---------------------------------------------------------------------------
-- End-to-end encrypted sync.
--
-- This table is a departure from everything above it, and the difference is worth naming:
-- the rows above hold only identifiers and timestamps, whereas these hold the user's actual
-- records — as ciphertext this server cannot read, and has no key for.
--
-- What is still visible here, and is stated in PRIVACY.md rather than glossed over:
-- how many records exist, roughly how large each is, when each last changed, and which
-- devices belong to the same space. The content is not.

CREATE TABLE IF NOT EXISTS sync_spaces (
  -- Random UUID minted on the device that created the space. Deliberately *not* derived from
  -- the passphrase: deriving it would make a weak passphrase enough to locate someone's data,
  -- turning an offline guessing attack into an online one.
  id            TEXT PRIMARY KEY,

  -- SHA-256 of a secret derived from the space passphrase, alongside the encryption key. Proves a
  -- caller knows the passphrase without this server ever holding anything that decrypts data — so a
  -- leaked space code is not enough to write into someone's space.
  join_hash     TEXT NOT NULL,

  -- Monotonic revision counter for the space. Every write takes the next value, which is what
  -- gives clients a cursor to pull from without relying on their own clocks.
  revision      INTEGER NOT NULL DEFAULT 0,

  created_at    INTEGER NOT NULL,
  last_write_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sync_members (
  space_id       TEXT NOT NULL REFERENCES sync_spaces(id) ON DELETE CASCADE,

  -- The device's ECDSA public key, as a JWK — the same identity that signs push scheduling.
  -- Membership is proved by a signature, so there is no password and no account here.
  device_pubkey  TEXT NOT NULL,

  joined_at      INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,

  PRIMARY KEY (space_id, device_pubkey)
) STRICT;

CREATE TABLE IF NOT EXISTS sync_records (
  space_id    TEXT NOT NULL REFERENCES sync_spaces(id) ON DELETE CASCADE,

  -- "entries:<uuid>". Opaque, and authenticated by AES-GCM as additional data, so this server
  -- cannot move one record's ciphertext onto another record's key without the client noticing.
  record_key  TEXT NOT NULL,

  -- AES-256-GCM, base64url, with the authentication tag appended. Unreadable here.
  ciphertext  TEXT,
  iv          TEXT,

  -- The client's own edit time, used for last-write-wins. Trusted only as an ordering hint:
  -- a device with a wrong clock can win arguments, which PRIVACY.md and DECISIONS.md both say.
  updated_at  INTEGER NOT NULL,

  -- A tombstone. The row is kept rather than deleted so that a device which has been offline
  -- learns about the deletion instead of re-uploading the record it still has.
  deleted     INTEGER NOT NULL DEFAULT 0,

  -- The space revision at which this row last changed. Clients pull `revision > cursor`.
  revision    INTEGER NOT NULL,

  PRIMARY KEY (space_id, record_key)
) STRICT;

-- The only read path: everything in a space changed since the client's cursor.
CREATE INDEX IF NOT EXISTS idx_sync_pull
  ON sync_records (space_id, revision);

-- ---------------------------------------------------------------------------
-- Lists shared with other people.
--
-- Sync (above) shares everything with your own devices, and its key comes from a passphrase
-- only you know. Sharing one list with another *person* cannot reuse that: the passphrase
-- decrypts the whole database, so handing it over to share a packing list would hand over
-- every note as well. Each shared list therefore has its own key, which travels inside the
-- invite rather than being derived from anything.
--
-- That moves one guarantee. For sync, this server is a place ciphertext sits. Here it is also
-- the thing that enforces *write* permission: read access is settled by who holds the key, but
-- nothing cryptographic stops a viewer from producing a valid ciphertext, so the refusal has to
-- happen here. PRIVACY.md says so plainly rather than implying the encryption covers it.

CREATE TABLE IF NOT EXISTS shared_lists (
  id            TEXT PRIMARY KEY,

  -- The creator's device key. Kept so ownership survives every member leaving, and so an owner
  -- can always be told apart from an editor who was granted write access.
  owner_pubkey  TEXT NOT NULL,

  revision      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_write_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS shared_members (
  list_id       TEXT NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
  device_pubkey TEXT NOT NULL,

  -- 'owner' | 'editor' | 'viewer'. Checked on every write; see worker/share.ts.
  role          TEXT NOT NULL,

  joined_at     INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,

  PRIMARY KEY (list_id, device_pubkey)
) STRICT;

CREATE TABLE IF NOT EXISTS shared_invites (
  -- SHA-256 of the invite token, never the token itself. A leaked database therefore cannot be
  -- used to join anything: the tokens are not in it, only their hashes.
  token_hash  TEXT PRIMARY KEY,

  list_id     TEXT NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,

  -- The role the invitee gets. Fixed when the invite is created, so redeeming cannot escalate it.
  role        TEXT NOT NULL,

  created_at  INTEGER NOT NULL,

  -- Invites expire because the key is inside them: an old message in a chat history should stop
  -- being a working door.
  expires_at  INTEGER NOT NULL,

  -- Single use. Once redeemed the row is kept rather than deleted, so a second attempt can be
  -- told "already used" instead of "never existed" — the difference matters when someone is
  -- trying to work out whether their invite was intercepted.
  redeemed_at INTEGER,
  redeemed_by TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS shared_records (
  list_id     TEXT NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,

  -- "packItems:<uuid>", authenticated as AES-GCM additional data exactly as in sync_records.
  record_key  TEXT NOT NULL,

  ciphertext  TEXT,
  iv          TEXT,

  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL,

  -- Which member last wrote this row, so a client can show "changed by" without the server
  -- learning anything it did not already know. It is a device key, not a name — the server has
  -- never been told anyone's name and this does not start.
  author      TEXT NOT NULL,

  PRIMARY KEY (list_id, record_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_shared_pull
  ON shared_records (list_id, revision);

-- Answers "which lists is this device in", which is the first call the client makes on open.
CREATE INDEX IF NOT EXISTS idx_shared_membership
  ON shared_members (device_pubkey);
