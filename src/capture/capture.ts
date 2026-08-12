/**
 * Capture: turning typed text into an Entry, and possibly into an Event.
 *
 * The invariant that governs everything here: **the Entry is saved first, unconditionally.**
 * Parsing runs afterwards and its failure is never allowed to cost the user their text. A
 * capture app that can lose a capture is worthless, and no amount of clever interpretation
 * makes up for it.
 *
 * Above the confidence threshold an Event is created silently and an undo is offered. Below it,
 * a proposal comes back for the user to confirm. The Entry survives either way, and is `Link`ed
 * rather than consumed — which is what makes re-parsing possible later and what makes the
 * original phrasing recoverable.
 */

import {
  db,
  type Entry,
  type EpochMs,
  type Event,
  type ID,
  type Link,
} from '../db/schema';
import { loadSettings } from '../db/settings';
import { tokenize } from '../db/tokenize';
import { detectLanguage } from '../parse/language';
import type { ActionableResult } from '../parse/actionable';
import type { ParsedEvent, ParseResult } from '../parse/types';

export interface CaptureResult {
  entry: Entry;
  parse: ParseResult;
  /**
   * Created silently because confidence cleared the threshold. The caller offers an undo.
   */
  event: Event | null;
  /**
   * Below the threshold: what we think was meant, for the user to confirm or correct. Null when
   * no date was found at all, which is the ordinary case for a plain note.
   */
  proposal: ParsedEvent | null;
  /** Whether to offer a one-tap conversion into a reminder. Only ever an offer. */
  actionable: ActionableResult;
}

export interface CaptureOptions {
  source?: Entry['source'];
  /** Injected in tests; the wall clock otherwise. */
  now?: EpochMs;
}

function buildEntry(text: string, source: Entry['source'], now: EpochMs): Entry {
  const body = text.trim();
  return {
    id: crypto.randomUUID(),
    body,
    // Verbatim, including whatever whitespace the user typed. Never rewritten.
    rawInput: text,
    capturedAt: now,
    source,
    language: detectLanguage(body),
    searchTokens: tokenize(body),
  };
}

async function createEvent(
  proposal: ParsedEvent,
  entryId: ID,
  now: EpochMs,
): Promise<Event> {
  const event: Event = {
    id: crypto.randomUUID(),
    title: proposal.title,
    startAt: proposal.startAt,
    endAt: proposal.endAt,
    timezone: proposal.timezone,
    isAllDay: proposal.isAllDay,
    location: null,
    travelBufferMinutes: 0,
    isPrivate: false,
    sourceEntryId: entryId,
    createdAt: now,
    updatedAt: now,
  };

  const link: Link = {
    id: crypto.randomUUID(),
    fromType: 'entry',
    fromId: entryId,
    toType: 'event',
    toId: event.id,
    relation: 'interpreted-as',
    createdAt: now,
  };

  await db.transaction('rw', db.events, db.links, async () => {
    await db.events.add(event);
    await db.links.add(link);
  });

  return event;
}

/**
 * Captures text.
 *
 * Never throws on account of parsing: `parseCapture` already swallows its own failures, and the
 * Entry write happens before parsing is even attempted.
 */
export async function captureText(
  text: string,
  { source = 'text', now = Date.now() }: CaptureOptions = {},
): Promise<CaptureResult> {
  const settings = await loadSettings();
  const entry = buildEntry(text, source, now);

  // First, and unconditionally.
  await db.entries.add(entry);

  // The grammars are loaded on demand rather than at launch. chrono-node is by far the largest
  // dependency in the app and is needed only once text has been submitted — which is already
  // after the Entry is safe, so the chunk fetch cannot cost anyone their capture. This is what
  // keeps the launch bundle within reach of the one-second capture requirement.
  const { parseCapture, detectActionable } = await import('../parse/index');

  const parse = parseCapture(entry.body, {
    reference: now,
    timezone: settings.timezone,
  });
  const actionable = detectActionable(entry.body, entry.language);

  if (!parse.event) {
    return { entry, parse, event: null, proposal: null, actionable };
  }

  // A titleless event is not worth creating silently, whatever the score says — there would be
  // nothing to show in the calendar. The confidence weights already push these below the
  // threshold; this is belt and braces for a case that would be visibly broken.
  const confident = parse.confidence >= settings.confidenceThreshold && parse.event.title !== '';

  if (!confident) {
    return { entry, parse, event: null, proposal: parse.event, actionable };
  }

  const event = await createEvent(parse.event, entry.id, now);
  return { entry, parse, event, proposal: null, actionable };
}

/**
 * Creates the Event the user confirmed, optionally with an edited title.
 *
 * Used for the below-threshold path, where the proposal was shown in a sheet.
 */
export async function confirmProposal(
  entryId: ID,
  proposal: ParsedEvent,
  now: EpochMs = Date.now(),
): Promise<Event> {
  return createEvent(proposal, entryId, now);
}

/**
 * Reverses a silent creation.
 *
 * The Event and its edges go; the Entry stays. That asymmetry is the whole point — undo means
 * "you misread me", not "forget what I said".
 */
export async function undoEventCreation(eventId: ID): Promise<void> {
  const edges = await db.links.where('[toType+toId]').equals(['event', eventId]).toArray();
  await db.transaction('rw', db.events, db.links, async () => {
    await db.links.bulkDelete(edges.map((edge) => edge.id));
    await db.events.delete(eventId);
  });
}
