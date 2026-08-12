/**
 * The capture field. The app's landing surface, deliberately.
 *
 * "Launch to capture under one second" is a hard requirement, so this mounts focused and does not
 * wait for anything — no settings read, no parse, no network — before accepting a keystroke.
 * Everything interesting happens after the text is already safe.
 *
 * The flow after submit:
 *   confident parse  → Event created, undo offered
 *   uncertain parse  → proposal sheet, nothing written to the calendar
 *   actionable text  → reminder offered, never created unasked
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Event, ID, Lang } from '../db/schema';
import { registerTrigger } from '../engine/index';
import type { RegisterOutcome } from '../engine/index';
import type { ParsedEvent } from '../parse/index';
import { captureText, confirmProposal, undoEventCreation } from '../capture/capture';
import { quickReminders, type QuickReminder } from '../capture/quickReminders';

export interface CaptureProps {
  locale: Lang;
  timezone: string;
}

/** What the field is currently asking the user, if anything. */
type Followup =
  | { kind: 'none' }
  | { kind: 'created'; event: Event }
  | { kind: 'proposal'; entryId: ID; proposal: ParsedEvent }
  | { kind: 'remind'; entryId: ID; offers: QuickReminder[] }
  | { kind: 'reminded'; at: number }
  | { kind: 'suppressed'; outcome: Extract<RegisterOutcome, { kind: 'suppressed' }>; entryId: ID };

export function Capture({ locale, timezone }: CaptureProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [followup, setFollowup] = useState<Followup>({ kind: 'none' });
  const [proposalTitle, setProposalTitle] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const formatTime = (at: number) =>
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(
      new Date(at),
    );

  async function submit() {
    const value = text;
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      const result = await captureText(value);
      // Cleared immediately on success: the text is in IndexedDB, and a field that keeps its
      // contents after saving invites accidental double capture.
      setText('');

      if (result.event) {
        setFollowup({ kind: 'created', event: result.event });
      } else if (result.proposal) {
        setProposalTitle(result.proposal.title);
        setFollowup({ kind: 'proposal', entryId: result.entry.id, proposal: result.proposal });
      } else if (result.actionable.isActionable) {
        setFollowup({
          kind: 'remind',
          entryId: result.entry.id,
          offers: quickReminders(Date.now(), timezone, result.parse.event?.startAt ?? null),
        });
      } else {
        setFollowup({ kind: 'none' });
      }
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function chooseReminder(entryId: ID, at: number) {
    const outcome = await registerTrigger({
      targetType: 'entry',
      targetId: entryId,
      condition: { kind: 'time', at, timezone },
      link: { fromType: 'entry', fromId: entryId, relation: 'reminds-of' },
    });

    if (outcome.kind === 'registered') {
      setFollowup({ kind: 'reminded', at: outcome.trigger.nextFireAt ?? at });
    } else if (outcome.kind === 'suppressed') {
      // Say why, and offer a time that would work. Never move it silently.
      setFollowup({ kind: 'suppressed', outcome, entryId });
    } else {
      setFollowup({ kind: 'none' });
    }
  }

  return (
    <section className="capture">
      <textarea
        ref={inputRef}
        className="capture__input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter saves; Shift+Enter is a newline. Capture should take one gesture.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={t('capture.placeholder')}
        rows={3}
        // Sentence case and autocorrect are helpful here; autocapitalising every word is not.
        autoCapitalize="sentences"
        autoComplete="off"
        spellCheck
      />
      <div className="capture__actions">
        <button type="button" className="button" onClick={() => void submit()} disabled={busy || !text.trim()}>
          {t('capture.createReminder')}
        </button>
      </div>

      {followup.kind === 'created' && (
        <div className="followup" role="status">
          <span>{t('capture.eventCreated')}</span>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              void undoEventCreation(followup.event.id);
              setFollowup({ kind: 'none' });
            }}
          >
            {t('capture.undo')}
          </button>
        </div>
      )}

      {followup.kind === 'proposal' && (
        <div className="followup followup--sheet">
          <strong>{t('capture.proposal.heading')}</strong>
          <label className="field">
            <span className="field__label">{t('capture.proposal.titleLabel')}</span>
            <input
              className="field__input"
              value={proposalTitle}
              placeholder={t('capture.proposal.titlePlaceholder')}
              onChange={(event) => setProposalTitle(event.target.value)}
            />
          </label>
          <div className="followup__time">
            {followup.proposal.isAllDay
              ? t('notify.event.allDayBody')
              : t('notify.event.body', { time: formatTime(followup.proposal.startAt) })}
          </div>
          <div className="capture__actions">
            <button
              type="button"
              className="button"
              disabled={!proposalTitle.trim()}
              onClick={() => {
                void confirmProposal(followup.entryId, {
                  ...followup.proposal,
                  title: proposalTitle.trim(),
                });
                setFollowup({ kind: 'none' });
              }}
            >
              {t('capture.proposal.confirm')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setFollowup({ kind: 'none' })}
            >
              {t('capture.proposal.discard')}
            </button>
          </div>
        </div>
      )}

      {followup.kind === 'remind' && (
        <div className="followup followup--sheet">
          <strong>{t('capture.remind.offer')}</strong>
          <div className="capture__actions capture__actions--wrap">
            {followup.offers.map((offer) => (
              <button
                key={offer.id}
                type="button"
                className="button button--quiet"
                onClick={() => void chooseReminder(followup.entryId, offer.at)}
              >
                {offer.id === 'atParsedTime'
                  ? t('capture.remind.atParsedTime', { time: formatTime(offer.at) })
                  : t(`capture.remind.${offer.id}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {followup.kind === 'reminded' && (
        <div className="followup" role="status">
          {t('capture.remind.set', { time: formatTime(followup.at) })}
        </div>
      )}

      {followup.kind === 'suppressed' && (
        <div className="followup followup--sheet" role="status">
          <span>
            {followup.outcome.reason === 'quiet-hours'
              ? t('capture.suppressed.quietHours')
              : t('capture.suppressed.dailyCap')}
          </span>
          {followup.outcome.suggestion === null ? (
            <span className="muted">{t('capture.suppressed.none')}</span>
          ) : (
            <button
              type="button"
              className="button"
              onClick={() =>
                void chooseReminder(followup.entryId, followup.outcome.suggestion as number)
              }
            >
              {t('capture.suppressed.useSuggestion', {
                time: formatTime(followup.outcome.suggestion),
              })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
