/**
 * The People screen: a list ordered by neglect, and a detail view per person.
 *
 * The list's ordering is the feature. Alphabetical would bury the one relationship that has
 * actually lapsed under twenty that have not, and noticing the lapse is the only reason this
 * screen exists — so `peopleWithStatus` sorts by how overdue a catch-up is and the UI just
 * renders that order.
 *
 * All timing arithmetic and every write live in `src/people/` and `src/engine/`; this file is
 * layout and form state.
 */

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db, FACT_KINDS, type FactKind, type ID, type Lang } from '../db/schema';
import { DAY_MS } from '../engine/time';
import { rankFacts } from '../engine/notify';
import { formatRelativeDays } from '../i18n/relative';
import {
  createFact,
  createPerson,
  deleteFact,
  deletePerson,
  entriesMentioning,
  formatAliases,
  logInteraction,
  parseAliases,
  peopleWithStatus,
  updatePerson,
  type PersonStatus,
} from '../people/people';

export interface PeopleProps {
  locale: Lang;
}

/** Named intervals, because "every 14 days" is not how anyone describes a friendship. */
const CADENCE_PRESETS: { days: number | null; key: string }[] = [
  { days: null, key: 'cadenceNone' },
  { days: 7, key: 'cadenceWeekly' },
  { days: 14, key: 'cadenceFortnightly' },
  { days: 30, key: 'cadenceMonthly' },
  { days: 90, key: 'cadenceQuarterly' },
];

interface EditorState {
  id: ID | null;
  name: string;
  aliases: string;
  cadenceDays: number | null;
}

export function People({ locale }: PeopleProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<ID | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const statuses = useLiveQuery(() => peopleWithStatus(), [], undefined);
  const selected = statuses?.find((status) => status.person.id === selectedId);

  // A person deleted from the detail view leaves nothing to show; fall back to the list rather
  // than rendering a blank screen.
  useEffect(() => {
    if (selectedId && statuses && !selected) setSelectedId(null);
  }, [selectedId, statuses, selected]);

  if (editor) {
    return (
      <PersonForm
        editor={editor}
        onChange={setEditor}
        onDone={() => setEditor(null)}
      />
    );
  }

  if (selected) {
    return (
      <PersonDetail
        status={selected}
        locale={locale}
        onBack={() => setSelectedId(null)}
        onEdit={() =>
          setEditor({
            id: selected.person.id,
            name: selected.person.name,
            aliases: formatAliases(selected.person.aliases),
            cadenceDays: selected.person.cadenceDays,
          })
        }
      />
    );
  }

  return (
    <section>
      <div className="month-header">
        <h2 className="section-heading">{t('people.heading')}</h2>
        <button
          type="button"
          className="button"
          onClick={() => setEditor({ id: null, name: '', aliases: '', cadenceDays: null })}
        >
          {t('people.add')}
        </button>
      </div>

      {statuses === undefined ? (
        <p className="empty">…</p>
      ) : statuses.length === 0 ? (
        <p className="card empty">{t('people.empty')}</p>
      ) : (
        <ul className="item-list">
          {statuses.map((status) => (
            <li key={status.person.id} className="item card">
              <button
                type="button"
                className="person-row"
                onClick={() => setSelectedId(status.person.id)}
              >
                <span className="item__title">{status.person.name}</span>
                <span className="item__body">
                  <CadenceStatus status={status} locale={locale} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The one line that says whether this relationship needs attention.
 *
 * Phrased through `Intl.RelativeTimeFormat` rather than a counted translation string, so Hebrew
 * gets its own plural and dual forms instead of an English shape with a number substituted in.
 */
function CadenceStatus({ status, locale }: { status: PersonStatus; locale: Lang }) {
  const { t } = useTranslation();
  const { overdueDays } = status;

  if (overdueDays === null) return <span className="muted">{t('people.notTracked')}</span>;
  if (overdueDays === 0) return <span data-overdue="true">{t('people.dueToday')}</span>;
  if (overdueDays > 0) {
    return (
      <span data-overdue="true">
        {t('people.dueAgo', { when: formatRelativeDays(-overdueDays, locale) })}
      </span>
    );
  }
  return <span>{t('people.dueSoon', { when: formatRelativeDays(-overdueDays, locale) })}</span>;
}

interface PersonDetailProps {
  status: PersonStatus;
  locale: Lang;
  onBack: () => void;
  onEdit: () => void;
}

function PersonDetail({ status, locale, onBack, onEdit }: PersonDetailProps) {
  const { t } = useTranslation();
  const { person } = status;
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const facts = useLiveQuery(
    () => db.facts.where('personId').equals(person.id).toArray(),
    [person.id],
    undefined,
  );
  const mentions = useLiveQuery(() => entriesMentioning(person, 8), [person.id, person.name], undefined);

  return (
    <section>
      <div className="month-header">
        <button type="button" className="button button--quiet button--small" onClick={onBack}>
          ‹ {t('people.back')}
        </button>
        <button type="button" className="button button--quiet button--small" onClick={onEdit}>
          {t('people.edit')}
        </button>
      </div>

      <div className="card">
        <h2 className="section-heading">{person.name}</h2>
        <p className="item__body">
          {person.lastInteractionAt === null
            ? t('people.neverSpoke')
            : t('people.lastSpoke', {
                when: formatRelativeDays(
                  Math.round((person.lastInteractionAt - Date.now()) / DAY_MS),
                  locale,
                ),
              })}
        </p>
        <p className="item__body">
          <CadenceStatus status={status} locale={locale} />
        </p>
        <div className="capture__actions">
          <button
            type="button"
            className="button"
            onClick={() => void logInteraction(person.id)}
          >
            {t('people.logInteraction')}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
        <span className="card__label">{t('people.facts')}</span>
        {facts === undefined ? (
          <p className="empty">…</p>
        ) : facts.length === 0 ? (
          <p className="empty">{t('people.noFacts')}</p>
        ) : (
          <ul className="item-list">
            {/* Ranked, so the thing most worth recalling is at the top — the same order the
                notification would have picked from. */}
            {rankFacts(facts).map((fact) => (
              <li key={fact.id} className="item item--fact">
                <span className="fact-kind">{t(`people.kind.${fact.kind}`)}</span>
                <span className="item__title">{fact.body}</span>
                <button
                  type="button"
                  className="button button--quiet button--small"
                  onClick={() => void deleteFact(fact.id)}
                >
                  {t('people.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <FactForm personId={person.id} />
      </div>

      <div className="card" style={{ marginBlockStart: 'var(--gap)' }}>
        <span className="card__label">{t('people.mentions')}</span>
        {mentions === undefined ? (
          <p className="empty">…</p>
        ) : mentions.length === 0 ? (
          <p className="empty">{t('people.noMentions')}</p>
        ) : (
          <ul className="item-list">
            {mentions.map((entry) => (
              <li key={entry.id} className="item">
                <span className="item__dot" aria-hidden="true" />
                <span className="item__title">{entry.body}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="capture__actions" style={{ marginBlockStart: 'var(--gap)' }}>
        {/* Two taps rather than a browser confirm dialog: this destroys every fact about the
            person, and a native confirm looks like a web page in a standalone app. */}
        {confirmingDelete ? (
          <>
            <button
              type="button"
              className="button button--danger"
              onClick={() => void deletePerson(person.id).then(onBack)}
            >
              {t('people.deleteConfirm')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setConfirmingDelete(false)}
            >
              {t('people.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setConfirmingDelete(true)}
          >
            {t('people.delete')}
          </button>
        )}
      </div>
    </section>
  );
}

function FactForm({ personId }: { personId: ID }) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<FactKind>('misc');

  async function save() {
    if (!body.trim()) return;
    await createFact({ personId, body, kind });
    setBody('');
    setKind('misc');
  }

  return (
    // `--sheet` rather than plain `.followup`: the base class is a wrapping row for inline
    // prompts, which sizes a field to its content instead of stretching it.
    <div className="followup followup--sheet" style={{ marginBlockStart: 'var(--gap)' }}>
      <label className="field">
        <span className="field__label">{t('people.addFact')}</span>
        <input
          className="field__input"
          value={body}
          placeholder={t('people.factPlaceholder')}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <div className="capture__actions capture__actions--wrap">
        {FACT_KINDS.map((option) => (
          <button
            key={option}
            type="button"
            className="button button--quiet button--small"
            data-active={kind === option}
            onClick={() => setKind(option)}
          >
            {t(`people.kind.${option}`)}
          </button>
        ))}
      </div>
      <div className="capture__actions">
        <button type="button" className="button" disabled={!body.trim()} onClick={() => void save()}>
          {t('people.save')}
        </button>
      </div>
    </div>
  );
}

interface PersonFormProps {
  editor: EditorState;
  onChange: (next: EditorState) => void;
  onDone: () => void;
}

function PersonForm({ editor, onChange, onDone }: PersonFormProps) {
  const { t } = useTranslation();
  const [suppressed, setSuppressed] = useState(false);

  async function save() {
    if (!editor.name.trim()) return;
    const input = {
      name: editor.name,
      aliases: parseAliases(editor.aliases),
      cadenceDays: editor.cadenceDays,
    };

    const outcome = editor.id
      ? await updatePerson(editor.id, input)
      : (await createPerson(input), null);

    // A cadence the settings will not permit is refused rather than silently moved, so say so
    // instead of leaving the user to discover no nudge ever arrives.
    if (outcome?.kind === 'suppressed') {
      setSuppressed(true);
      return;
    }
    onDone();
  }

  return (
    <section>
      <div className="followup followup--sheet">
        <label className="field">
          <span className="field__label">{t('people.name')}</span>
          <input
            className="field__input"
            value={editor.name}
            placeholder={t('people.namePlaceholder')}
            onChange={(event) => onChange({ ...editor, name: event.target.value })}
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field__label">{t('people.aliases')}</span>
          <input
            className="field__input"
            value={editor.aliases}
            placeholder={t('people.aliasesPlaceholder')}
            onChange={(event) => onChange({ ...editor, aliases: event.target.value })}
          />
          <span className="field__help">{t('people.aliasesHelp')}</span>
        </label>

        <div className="field">
          <span className="field__label">{t('people.cadence')}</span>
          <div className="capture__actions capture__actions--wrap">
            {CADENCE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className="button button--quiet button--small"
                data-active={editor.cadenceDays === preset.days}
                onClick={() => onChange({ ...editor, cadenceDays: preset.days })}
              >
                {t(`people.${preset.key}`)}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="field__label">{t('people.cadenceCustomLabel')}</span>
          <input
            className="field__input"
            type="number"
            min="1"
            inputMode="numeric"
            value={editor.cadenceDays ?? ''}
            onChange={(event) =>
              onChange({
                ...editor,
                cadenceDays: event.target.value === '' ? null : Number(event.target.value),
              })
            }
          />
        </label>

        {suppressed && <p className="empty">{t('people.cadenceSuppressed')}</p>}

        <div className="capture__actions">
          <button
            type="button"
            className="button"
            disabled={!editor.name.trim()}
            onClick={() => void save()}
          >
            {t('people.save')}
          </button>
          <button type="button" className="button button--quiet" onClick={onDone}>
            {t('people.cancel')}
          </button>
        </div>
      </div>
    </section>
  );
}
