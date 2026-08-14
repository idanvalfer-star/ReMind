/**
 * The entity graph. This is the source of truth for the whole app — the Cloudflare
 * Worker holds nothing but opaque UUIDs and timestamps (see PRIVACY.md).
 *
 * Conventions, applied without exception:
 *
 * - **Ids** are client-generated UUIDs. Required so `Trigger.id` can be handed to the
 *   push backend without leaking anything, and it makes JSON re-import idempotent.
 * - **Instants** are UTC epoch milliseconds, with the IANA zone in a separate field
 *   where wall-clock meaning matters. No `Date` objects and no ISO strings in the DB:
 *   numbers are indexable and range-queryable, the other two are not reliably.
 * - **Indexed booleans are `0 | 1`**, because IndexedDB has no boolean key type.
 *   Un-indexed flags stay real booleans.
 */

import Dexie, { type Table } from 'dexie';

/** Bumped whenever `stores()` changes. Also stamped into JSON exports. */
export const DB_VERSION = 6;

// ---------------------------------------------------------------- primitives

/** `crypto.randomUUID()`. */
export type ID = string;
/** UTC epoch milliseconds. */
export type EpochMs = number;
/** IANA zone name, e.g. `Asia/Jerusalem`. */
export type IanaTz = string;
/** Wall-clock time of day, `HH:mm`, 24-hour. */
export type HHmm = string;

export type Lang = 'en' | 'he';
export const LANGUAGES: readonly Lang[] = ['en', 'he'] as const;

/**
 * Every addressable node in the graph.
 *
 * `digest` is the odd one: there is no `Digest` table, because there is only ever one and it has no
 * state beyond the settings that describe it. It exists as a target type so the daily
 * spaced-repetition digest can be an ordinary trigger — subject to the same quiet hours and cap as
 * everything else — rather than a special case bolted onto the scheduler.
 */
export type EntityType =
  | 'entry'
  | 'event'
  | 'person'
  | 'fact'
  | 'trip'
  | 'packItem'
  | 'trigger'
  | 'digest';

export interface GeoPoint {
  lat: number;
  lng: number;
  label?: string;
}

// ---------------------------------------------------------------- capture

/**
 * The universal capture unit. Everything captured becomes an Entry first and is then
 * interpreted; interpretation never destroys the Entry, it adds a `Link`. That is what
 * makes re-parsing possible later and what makes the app trustworthy now.
 */
export interface Entry {
  id: ID;
  /** Cleaned text — what the UI renders. */
  body: string;
  /** Verbatim: what was typed, or what speech recognition returned. Never rewritten. */
  rawInput: string;
  capturedAt: EpochMs;
  source: 'text' | 'voice' | 'ocr';
  language: Lang;
  /**
   * Terms for keyword search, indexed `*searchTokens` (a real inverted index — no
   * search library needed). Produced by `tokenize()`; never write it by hand.
   */
  searchTokens: string[];
}

// ---------------------------------------------------------------- calendar

export interface Event {
  id: ID;
  /**
   * Not in the original spec, deliberately added: a calendar needs a display label,
   * and it cannot borrow `Entry.body` because editing an event title would rewrite the
   * original phrasing the Entry exists to preserve.
   */
  title: string;
  startAt: EpochMs;
  endAt: EpochMs;
  timezone: IanaTz;
  /** When true, `startAt`/`endAt` are local-midnight boundaries in `timezone`. */
  isAllDay: boolean;
  location: GeoPoint | null;
  /** Shifts `event-adjacent` triggers earlier. 0 when travel is irrelevant. */
  travelBufferMinutes: number;
  /** Suppresses body text in notifications; the title is replaced by a generic string. */
  isPrivate: boolean;
  /** Denormalised provenance, mirroring `Fact.sourceEntryId`. A `Link` also exists. */
  sourceEntryId: ID | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

// ---------------------------------------------------------------- people

export interface Person {
  id: ID;
  name: string;
  /**
   * Other ways this person gets written down — nicknames, a Hebrew spelling of a name
   * usually typed in English, a surname on its own. Indexed `*aliases`, so mention
   * detection is an index hit rather than a scan over every person.
   */
  aliases: string[];
  /** Days between check-ins. `null` means this person is not on a cadence. */
  cadenceDays: number | null;
  lastInteractionAt: EpochMs | null;
  /**
   * The cadence clock's starting point for someone never yet interacted with. Without it,
   * a new person with a 14-day cadence has no anchor and the first nudge has no date.
   */
  createdAt: EpochMs;
}

export type FactKind = 'preference' | 'gift-idea' | 'milestone' | 'relation' | 'misc';

export const FACT_KINDS: readonly FactKind[] = [
  'preference',
  'gift-idea',
  'milestone',
  'relation',
  'misc',
] as const;

/** An atom of memory about a Person. A coffee order and a kid's name are the same shape. */
export interface Fact {
  id: ID;
  personId: ID;
  body: string;
  kind: FactKind;
  /** 0..1 */
  confidence: number;
  sourceEntryId: ID | null;
  createdAt: EpochMs;
}

// ---------------------------------------------------------------- trips

export type TransitMode = 'air' | 'rail' | 'road' | 'sea' | 'mixed';

export const TRANSIT_MODES: readonly TransitMode[] = ['air', 'rail', 'road', 'sea', 'mixed'] as const;

/** One day of a destination forecast, as Open-Meteo returns it. */
export interface ForecastDay {
  /** `YYYY-MM-DD` local to the destination, which is how the API keys its daily series. */
  date: string;
  minC: number;
  maxC: number;
  precipMm: number;
}

/**
 * A cached destination forecast.
 *
 * Cached on the Trip rather than fetched on render, because it is the only network call in the whole
 * app and it must be a thing the user chose to do once — not something that happens every time a
 * screen appears. See PRIVACY.md.
 */
export interface Forecast {
  fetchedAt: EpochMs;
  /** Resolved by Open-Meteo's geocoder, kept so a refresh needs no second name lookup. */
  latitude: number;
  longitude: number;
  /** What the geocoder actually matched, which may not be what was typed. */
  resolvedName: string;
  days: ForecastDay[];
}

export interface Trip {
  id: ID;
  destination: string;
  startAt: EpochMs;
  endAt: EpochMs;
  purpose: string;
  transitMode: TransitMode;
  luggageConstraint: string | null;
  /** The zone the *traveller* is in when packing, so stage reminders land at sane local hours. */
  timezone: IanaTz;
  /** Null until the user explicitly asks for a forecast. */
  forecast: Forecast | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export type PackCategory = 'documents' | 'clothing' | 'toiletries' | 'tech' | 'health' | 'misc';

export const PACK_CATEGORIES: readonly PackCategory[] = [
  'documents',
  'clothing',
  'toiletries',
  'tech',
  'health',
  'misc',
] as const;

/**
 * Why an item is on the list.
 *
 * Stored because a generated packing list is only trustworthy if it can say where each line came
 * from. "Umbrella" is reasonable when the forecast says rain and baffling otherwise, and a list you
 * cannot interrogate is one you stop reading.
 */
export type PackOrigin = 'template' | 'weather' | 'learned' | 'manual';

export interface PackItem {
  id: ID;
  tripId: ID;
  label: string;
  quantity: number;
  packed: 0 | 1;
  isReturnLeg: 0 | 1;
  category: PackCategory;
  origin: PackOrigin;
  createdAt: EpochMs;
}

// ---------------------------------------------------------------- semantic search

/**
 * One entry's embedding vector.
 *
 * A separate table rather than a field on `Entry` for three reasons that all point the same way:
 *
 * - An embedding is derived data. Losing the whole table costs a re-index, not a memory.
 * - It is bulky next to the rest of an `Entry`, and every query that reads entries — search,
 *   mention matching, the review queue — would carry a kilobyte and a half per row it does not use.
 * - `TABLE_NAMES` drives the JSON backup, and this table is deliberately excluded from it. A backup
 *   should hold what you wrote, not several megabytes of floats that can be recomputed.
 */
export interface Embedding {
  /** The Entry's id. One vector per entry, so the entry id *is* the primary key. */
  entryId: ID;
  /**
   * Which model produced it. Vectors from different models are not comparable, so a model change
   * invalidates the index rather than silently returning nonsense.
   */
  model: string;
  /** Unit-normalised at index time, so search is a dot product. */
  vector: Float32Array;
  /** What the vector was computed from, so an edited Entry can be detected as stale. */
  bodyHash: string;
  createdAt: EpochMs;
}

// ---------------------------------------------------------------- resurfacing

export type TriggerKind = 'time' | 'event-adjacent' | 'cadence' | 'spaced';

/**
 * The *rule*. `Trigger.nextFireAt` is the materialised result of evaluating it against
 * the clock, quiet hours and the daily cap.
 */
export type TriggerCondition =
  | { kind: 'time'; at: EpochMs; timezone: IanaTz }
  | { kind: 'event-adjacent'; eventId: ID; offsetMinutes: number; includeTravelBuffer: boolean }
  | {
      kind: 'cadence';
      personId: ID;
      days: number;
      /**
       * Minutes past local midnight to land on. A cadence reminder is not tied to a moment
       * the way an event is — "sometime around now, N days later" — so without a preferred
       * hour it would inherit whatever minute the person was added at, and a 03:00 nudge is
       * suppressed by quiet hours rather than delivered. The hour is part of the rule.
       */
      atMinuteOfDay: number;
      timezone: IanaTz;
    }
  | {
      kind: 'spaced';
      entryId: ID;
      /** SM-2 easiness factor, ≥ 1.3. */
      ease: number;
      intervalDays: number;
      reps: number;
      /**
       * When this card was last shown. The next due date is derived from it rather than
       * stored, so a change to `intervalDays` takes effect without a second write.
       */
      lastReviewedAt: EpochMs;
      atMinuteOfDay: number;
      timezone: IanaTz;
    };

export interface Trigger {
  /** The only piece of this record the push backend ever sees. */
  id: ID;
  targetType: EntityType;
  targetId: ID;
  kind: TriggerKind;
  condition: TriggerCondition;
  /**
   * `null` means "not scheduled". `null` is not a valid IndexedDB key, so those rows
   * drop out of the `[active+nextFireAt]` index automatically — relied upon, not
   * incidental: the due-trigger query never has to filter them out.
   */
  nextFireAt: EpochMs | null;
  lastFiredAt: EpochMs | null;
  active: 0 | 1;
  snoozedUntil: EpochMs | null;
  /**
   * Stored but unused for now. There is no Geofencing API on the web, so location
   * resurfacing is opportunistic (checked on app open); keeping the column means that
   * upgrade needs no migration.
   */
  location: (GeoPoint & { radiusM: number }) | null;
  /** What the backend last confirmed it holds, so drift is detectable on reconcile. */
  syncedFireAt: EpochMs | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export type TriggerResponse = 'acted' | 'dismissed' | 'snoozed' | 'none';

/**
 * One row per delivered reminder. Added because "log every fired trigger with the
 * user's response" needs somewhere to live. Nothing tunes on this yet; it is recorded
 * now so that when something does, there is history to learn from.
 */
export interface TriggerFire {
  id: ID;
  triggerId: ID;
  firedAt: EpochMs;
  deliveredVia: 'push' | 'app-open';
  /** 1 when the local lookup failed and the generic fallback text was shown. */
  lookupFailed: 0 | 1;
  response: TriggerResponse;
  respondedAt: EpochMs | null;
}

// ---------------------------------------------------------------- graph edges

/**
 * Polymorphic edge. This is the mechanism by which a note about a vase reaches a
 * birthday — the cross-module behaviour is the product, so the edge is a first-class
 * table rather than a foreign key bolted onto each entity.
 */
export interface Link {
  id: ID;
  fromType: EntityType;
  fromId: ID;
  toType: EntityType;
  toId: ID;
  relation: LinkRelation;
  createdAt: EpochMs;
}

export type LinkRelation =
  /** entry → event: this Entry was interpreted as that Event. */
  | 'interpreted-as'
  /** entry → trigger: this Entry produced that reminder. */
  | 'reminds-of'
  /** trigger → event | person: this reminder hangs off that thing. */
  | 'about';

// ---------------------------------------------------------------- sync

/**
 * This device's membership of an end-to-end encrypted sync space.
 *
 * A singleton, and deliberately *not* in `TABLE_NAMES`: like `pushRegistration` it is per-install, and
 * a backup restored onto another device must not silently inherit the first device's sync membership.
 *
 * The key is a non-extractable `CryptoKey`. It is stored rather than re-derived on every launch —
 * 600,000 PBKDF2 iterations is about a second — but because it is non-extractable, storing it does not
 * put the key bytes anywhere they could be read out. If IndexedDB is evicted the passphrase has to be
 * typed again, which is the correct consequence.
 */
export interface SyncSpace {
  id: 'singleton';
  spaceId: ID;
  /** Base64url PBKDF2 salt. Non-secret. */
  salt: string;
  key: CryptoKey;
  /** Sealed known constant, so a mistyped passphrase is caught at setup rather than at first sync. */
  verifier: { ciphertext: string; iv: string };
  /**
   * SHA-256 of the passphrase-derived join secret — the membership proof sent on every sync call.
   *
   * Stored rather than recomputed because the AES key is non-extractable, so the join secret cannot be
   * recovered from it, and re-deriving it would mean 600,000 PBKDF2 iterations before every sync.
   *
   * Storing it is not a meaningful weakening: the server already holds this exact value, and this
   * device already holds the encryption key, which is strictly more sensitive. Deriving it from the
   * *verifier* instead would not work at all — the verifier's ciphertext carries a random IV, so two
   * devices with the same passphrase would compute different hashes and the second could never join.
   */
  joinHash: string;
  enabled: boolean;
  lastSyncedAt: EpochMs | null;
  /** Server cursor: the highest revision this device has already pulled. */
  cursor: number;
}

/**
 * Per-record sync bookkeeping.
 *
 * Separate from the entities themselves so that adding sync required no change to `Entry`, `Person`,
 * `PackItem` and the rest. The alternative — an `updatedAt` on every synced table — would have touched
 * every entity and every writer of one, to store something only this subsystem reads.
 *
 * `hash` is what makes change detection work without those timestamps: a row whose canonical hash
 * differs from the one recorded here has been edited since it was last seen.
 */
export interface SyncMeta {
  /** `"entries:<id>"`. */
  key: string;
  hash: string;
  /** When this device last observed the record change. Drives last-write-wins. */
  updatedAt: EpochMs;
  /** Null until the record has been pushed. */
  syncedAt: EpochMs | null;
  /** A tombstone: the row is gone locally and the deletion still needs propagating. */
  deleted: 0 | 1;
}

// ---------------------------------------------------------------- shared lists

/**
 * What a member may do with a shared list.
 *
 * Read access is enforced by the key: without it there is nothing to read but ciphertext. **Write
 * access is enforced by the server**, which knows each member's device key and rejects a push from a
 * viewer. That split is worth stating plainly, because it is the one place this design relies on the
 * server behaving: a viewer who modified the client could still produce valid ciphertext, and only the
 * server's refusal stops it from landing. Nothing about roles is a secret from anyone holding the key.
 */
export type ShareRole = 'owner' | 'editor' | 'viewer';

export const SHARE_ROLES: readonly ShareRole[] = ['owner', 'editor', 'viewer'];

/**
 * A list shared with other *people*, as opposed to sync, which shares everything with your own devices.
 *
 * These are different problems and they need different keys. The sync key comes from a passphrase and
 * covers the whole database, so handing it to a travel companion so they can see one packing list would
 * hand them every note, person and event as well. A shared list therefore carries **its own key**, and
 * that key travels inside the invite.
 *
 * The consequence, stated here because it cannot be designed away: **whoever sees an invite can read
 * the list.** The key is in it. Invites are single-use and expire so that a stale message in a chat
 * history stops being a door, but for as long as one is live it is the credential.
 *
 * Deliberately excluded from `TABLE_NAMES`, like `pushRegistration` and `syncSpace`. A backup is a
 * plain JSON file the user downloads, and putting live list keys in it would be a worse failure than
 * asking a restored device to re-join from a fresh invite.
 */
export interface SharedList {
  /** Server-assigned list id. */
  id: ID;
  /**
   * Raw AES-256 key material, base64url.
   *
   * Stored as bytes rather than a `CryptoKey` because the owner has to be able to put it into an
   * invite, so it cannot be non-extractable the way the sync key is. Storing an extractable `CryptoKey`
   * instead would look stricter while being exactly as readable.
   */
  key: string;
  /** What this list is a view of. Only packing lists for now; the discriminant keeps it open. */
  kind: 'packing';
  /** The local trip whose pack items this list shares, if this device has one. */
  tripId: ID | null;
  /** Shown in the UI. Encrypted like any other field when it goes to the server. */
  title: string;
  role: ShareRole;
  /** Highest revision already pulled. */
  cursor: number;
  lastSyncedAt: EpochMs | null;
  createdAt: EpochMs;
}

/**
 * Per-record bookkeeping for shared lists, mirroring `SyncMeta`.
 *
 * Separate from `syncMeta` rather than shared with it: the same `PackItem` can belong to a shared list
 * *and* to your own encrypted sync, and the two push to different places at different revisions. One
 * table keyed only by record would have let one subsystem's cursor overwrite the other's.
 */
export interface ShareMeta {
  /** `"<listId>/packItems:<id>"` — the list id is part of the key for exactly the reason above. */
  key: string;
  listId: ID;
  hash: string;
  updatedAt: EpochMs;
  syncedAt: EpochMs | null;
  deleted: 0 | 1;
}

// ---------------------------------------------------------------- singletons

export interface QuietHours {
  enabled: boolean;
  /** Inclusive start of the *silent* window, local wall clock. May wrap past midnight. */
  start: HHmm;
  /** Exclusive end of the silent window. */
  end: HHmm;
}

/**
 * The daily spaced-repetition digest.
 *
 * One notification a day carrying a count, rather than one per note. Per-note pushes would spend the
 * entire daily cap on review prompts and starve the reminders the user actually set.
 */
export interface DigestSettings {
  enabled: boolean;
  /** Minutes past local midnight. */
  atMinuteOfDay: number;
  /** Beyond this many due notes, the digest says "lots" rather than a number nobody will act on. */
  maxItems: number;
}

export interface Settings {
  id: 'singleton';
  locale: Lang;
  /** The user's home zone; new events default to it. */
  timezone: IanaTz;
  /** Enforced before a trigger is ever registered, never at delivery time. */
  quietHours: QuietHours;
  /** Maximum reminders scheduled per local day. */
  dailyCap: number;
  /** At or above this, Entry→Event creates silently with undo; below, it asks first. */
  confidenceThreshold: number;
  /**
   * Kill switch for any network-based interpretation. Nothing reads it as `true` yet —
   * parsing is entirely deterministic and offline — but the switch is the user's
   * guarantee, so it exists from the start.
   */
  allowNetworkInterpretation: boolean;
  lastExportAt: EpochMs | null;
  /** Nag for a JSON backup after this many days. iOS can evict IndexedDB. */
  backupReminderDays: number;
  digest: DigestSettings;
  /**
   * Whether the on-device embedding model may be downloaded and used.
   *
   * Off by default and never enabled implicitly. Turning it on costs a ~130 MB one-time download, and
   * a feature that silently spends that much of someone's data allowance is not a feature.
   */
  semanticSearchEnabled: boolean;
  onboarding: {
    dismissedInstallSheet: boolean;
    /** True once the user has been asked for notification permission in standalone. */
    completedPushPrompt: boolean;
  };
}

/**
 * The device's push subscription. Deliberately *not* merged into `Settings`: it is
 * per-install rather than per-user, and it must be dropped on export/import so a
 * restored backup never inherits another install's subscription.
 */
export interface PushRegistration {
  id: 'singleton';
  /** Our opaque handle for the backend row. */
  subscriptionId: ID;
  endpoint: string;
  /** Subscription key material. Required server-side to encrypt — see PRIVACY.md. */
  p256dh: string;
  auth: string;
  vapidPublicKey: string;
  /**
   * Non-extractable signing key for authenticating writes to the backend. The private
   * half is stored as a `CryptoKey` and cannot be read out of IndexedDB, by us or by
   * anything else.
   */
  signingKeyPair: CryptoKeyPair;
  registeredAt: EpochMs;
  lastReconciledAt: EpochMs | null;
}

// ---------------------------------------------------------------- database

export class ReMindDB extends Dexie {
  entries!: Table<Entry, ID>;
  events!: Table<Event, ID>;
  people!: Table<Person, ID>;
  facts!: Table<Fact, ID>;
  trips!: Table<Trip, ID>;
  packItems!: Table<PackItem, ID>;
  triggers!: Table<Trigger, ID>;
  triggerFires!: Table<TriggerFire, ID>;
  links!: Table<Link, ID>;
  embeddings!: Table<Embedding, ID>;
  syncSpace!: Table<SyncSpace, 'singleton'>;
  syncMeta!: Table<SyncMeta, string>;
  sharedLists!: Table<SharedList, ID>;
  shareMeta!: Table<ShareMeta, string>;
  settings!: Table<Settings, 'singleton'>;
  pushRegistration!: Table<PushRegistration, 'singleton'>;

  constructor(name = 'remind') {
    super(name);

    // Version 1 is kept rather than folded into the latest declaration. Dexie can infer the
    // upgrade either way, but the chain is the only record of what shipped, and this app is
    // already installed on a device holding real data.
    this.version(1).stores({
      entries: 'id, capturedAt, source, language, *searchTokens',
      events: 'id, startAt, endAt, [startAt+endAt], sourceEntryId',
      people: 'id, name, *aliases, lastInteractionAt, cadenceDays',
      facts: 'id, personId, kind, sourceEntryId',
      trips: 'id, startAt, endAt, destination',
      packItems: 'id, tripId, packed, isReturnLeg',
      triggers:
        'id, [active+nextFireAt], nextFireAt, kind, [targetType+targetId], snoozedUntil, lastFiredAt',
      triggerFires: 'id, triggerId, firedAt, response',
      links: 'id, [fromType+fromId], [toType+toId], relation',
      settings: 'id',
      pushRegistration: 'id',
    });

    // v2 — people and trips stop being declarations and start being features. Only indexes
    // change; no row is rewritten, so no `upgrade()` is needed. `people` and `facts` were
    // empty in v1 (nothing could write them), which is why `createdAt` can be added as a
    // required field without a backfill.
    this.version(2).stores({
      people: 'id, name, *aliases, lastInteractionAt, cadenceDays, createdAt',
      facts: 'id, personId, [personId+kind], kind, sourceEntryId, createdAt',
      // `active` on its own: opportunistic location resurfacing needs every live trigger
      // regardless of when it is due, and Dexie cannot query a prefix of a compound index.
      triggers:
        'id, active, [active+nextFireAt], nextFireAt, kind, [targetType+targetId], snoozedUntil, lastFiredAt',
    });

    // v3 — trips and packing. Again indexes only; `trips` and `packItems` were unwritable before
    // this, so the new required fields need no backfill.
    this.version(3).stores({
      trips: 'id, startAt, endAt, [startAt+endAt], destination, createdAt',
      // `[tripId+isReturnLeg]` is the list query: the outbound list and the return checklist are
      // separate screens over one table, and neither should filter the other in memory.
      packItems: 'id, tripId, [tripId+isReturnLeg], [tripId+category], packed, isReturnLeg, label',
    });

    // v4 — semantic search. `entryId` is the primary key rather than a separate id: there is exactly
    // one current vector per entry, and making that a schema property means a re-index overwrites
    // rather than accumulating stale rows nobody would ever notice.
    this.version(4).stores({
      embeddings: 'entryId, model, createdAt',
    });

    // v5 — end-to-end encrypted sync. `syncMeta` is indexed on `syncedAt` because "what still needs
    // pushing" is the query the sync loop runs first and most often.
    this.version(5).stores({
      syncSpace: 'id',
      syncMeta: 'key, syncedAt, updatedAt, deleted',
    });

    // v6 — lists shared with other people. `shareMeta` is indexed on `listId` as well as the
    // compound key because every push and pull is scoped to one list, and on `[listId+syncedAt]`
    // because "what does *this* list still need to send" is the query the share loop opens with.
    this.version(6).stores({
      sharedLists: 'id, tripId, kind, role',
      shareMeta: 'key, listId, [listId+syncedAt], updatedAt, deleted',
    });
  }
}

export const db = new ReMindDB();

/** Every table name, in a stable order. Drives JSON export/import. */
export const TABLE_NAMES = [
  'entries',
  'events',
  'people',
  'facts',
  'trips',
  'packItems',
  'triggers',
  'triggerFires',
  'links',
  'settings',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];
