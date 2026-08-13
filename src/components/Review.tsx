/**
 * The spaced-repetition review card, on Today.
 *
 * There are no home-screen widgets on the web, so this card plus the daily digest push is the whole
 * surface — which is what the brief settles on, for exactly that reason.
 *
 * Four answers rather than three. SM-2 has "forgot / recalled / easy"; the fourth, "stop asking", is
 * the one that makes the feature bearable, because without a way out the only escape from the
 * rotation is an interval that grows until the note effectively vanishes.
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import type { Lang } from '../db/schema';
import { formatRelativeDays } from '../i18n/relative';
import { recordReview, reviewQueue } from '../spaced/review';
import type { Answer } from '../spaced/sm2';

export interface ReviewProps {
  locale: Lang;
}

/** In the order they escalate, so the buttons read left to right as increasing confidence. */
const ANSWERS: readonly Answer[] = ['forgot', 'recalled', 'easy'];

export function Review({ locale }: ReviewProps) {
  const { t } = useTranslation();
  // One at a time. A list of ten notes with three buttons each is a chore; one card with an obvious
  // next action is a habit.
  const queue = useLiveQuery(() => reviewQueue(1), [], undefined);
  const item = queue?.[0];

  if (!item) return null;

  return (
    <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
      <div className="month-header">
        <span className="card__label" style={{ marginBlockEnd: 0 }}>
          {t('review.heading')}
        </span>
        {item.overdueDays > 0 && (
          <span className="item__time">
            {formatRelativeDays(-item.overdueDays, locale)}
          </span>
        )}
      </div>

      <p className="item__title">{item.entry.body}</p>
      <p className="field__help">{t('review.prompt')}</p>

      <div className="capture__actions capture__actions--wrap">
        {ANSWERS.map((given) => (
          <button
            key={given}
            type="button"
            className="button button--quiet button--small"
            onClick={() => void recordReview(item.entry.id, given)}
          >
            {t(`review.${given}`)}
          </button>
        ))}
        <button
          type="button"
          className="button button--quiet button--small"
          onClick={() => void recordReview(item.entry.id, 'dismissed')}
        >
          {t('review.dismiss')}
        </button>
      </div>
    </div>
  );
}
