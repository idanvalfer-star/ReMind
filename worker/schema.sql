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
