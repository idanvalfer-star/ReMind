/**
 * Keyword search over captured Entries.
 *
 * Searches the `Entry`, not the interpretation — which is the point of keeping Entries after they
 * become Events. You find things by what you wrote, in the words you wrote them in, even after the
 * parser turned them into something else.
 */

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db, type ID, type Lang } from '../db/schema';
import { searchEntries, type SearchHit } from '../search/search';
import { enrol, unenrol } from '../spaced/review';

export interface SearchProps {
  locale: Lang;
  timezone: string;
}

/** Long enough not to thrash IndexedDB on every keystroke, short enough to feel immediate. */
const DEBOUNCE_MS = 150;

export function Search({ locale, timezone }: SearchProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchEntries(query).then((results) => {
        // A slow query for an abandoned term must not overwrite a newer one's results.
        if (!cancelled) setHits(results);
      });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  /**
   * Which entries are already in the review rotation.
   *
   * One query over active triggers rather than one per result: the set is small, and a per-row query
   * would fire on every keystroke's worth of results.
   */
  const enrolled = useLiveQuery(
    async () => {
      const active = await db.triggers.where('active').equals(1).toArray();
      return new Set(
        active.filter((trigger) => trigger.condition.kind === 'spaced').map((t) => t.targetId),
      );
    },
    [],
    new Set<ID>(),
  );

  const formatDate = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: timezone,
    }).format(new Date(at));

  return (
    <section>
      <input
        className="field__input"
        type="search"
        value={query}
        placeholder={t('search.placeholder')}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
      />

      {hits === null ? (
        <p className="muted">{t('search.prompt')}</p>
      ) : hits.length === 0 ? (
        <p className="empty">{t('search.noResults')}</p>
      ) : (
        <>
          <p className="muted">{t('search.results', { count: hits.length })}</p>
          <ul className="item-list">
            {hits.map((hit) => (
              <li key={hit.entry.id} className="item card">
                <div className="item__time">{formatDate(hit.entry.capturedAt)}</div>
                {/* The body as captured, not the parsed title. */}
                <div className="item__title">{hit.entry.body}</div>
                {/* Search is where enrolment belongs: you have just gone looking for something, which
                    is the moment you know whether it is worth keeping in front of you. */}
                <RotationToggle entryId={hit.entry.id} enrolled={enrolled.has(hit.entry.id)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Puts an entry into the spaced-repetition rotation, or takes it out. */
function RotationToggle({ entryId, enrolled }: { entryId: ID; enrolled: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="capture__actions">
      <button
        type="button"
        className="button button--quiet button--small"
        data-active={enrolled}
        onClick={() => void (enrolled ? unenrol(entryId) : enrol(entryId))}
      >
        {enrolled ? t('review.enrolled') : t('review.enrol')}
      </button>
    </div>
  );
}
