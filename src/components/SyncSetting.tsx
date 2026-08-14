/**
 * The sync card in Settings.
 *
 * Three states: not syncing, setting up, and syncing. The one that needed the most care is the first,
 * because it is where the user is asked to accept a consequence that cannot be undone: **a forgotten
 * passphrase means the synced copy is unreadable, permanently.** That is stated before the field, not
 * after the button, and it is not softened — there is no reset link to fall back on, because there is
 * no reset.
 *
 * The space code is displayed with an explicit note that it carries no key, because the natural
 * assumption about a "code" that unlocks your data on another device is that it is a secret to be
 * guarded. It is not: the passphrase is the secret, and it never travels.
 */

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db, type Lang } from '../db/schema';
import { formatRelativeDays } from '../i18n/relative';
import { DAY_MS } from '../engine/time';
import { encodeSpaceCode } from '../sync/crypto';
import { createSpace, joinSpace, leaveSpace, runSync, type SyncOutcome } from '../sync/sync';

export interface SyncSettingProps {
  locale: Lang;
  /** Sync signs its requests with the push identity, so it cannot run before that exists. */
  hasPushIdentity: boolean;
}

/** Long enough that PBKDF2 has something to work with. Not a strength meter — just a floor. */
const MIN_PASSPHRASE = 12;

type Notice =
  | { kind: 'none' }
  | { kind: 'weak' }
  | { kind: 'bad-code' }
  | { kind: 'wrong-passphrase' }
  | { kind: 'offline' }
  | { kind: 'result'; outcome: Extract<SyncOutcome, { kind: 'synced' }> };

export function SyncSetting({ locale, hasPushIdentity }: SyncSettingProps) {
  const { t } = useTranslation();
  // The `?? null` is load-bearing. `useLiveQuery` reports "not resolved yet" as `undefined`, and
  // `get()` also resolves to `undefined` when there is no space — so without it the two states are
  // indistinguishable, and the card renders nothing in the one state that matters most: no space yet,
  // which is exactly when the user needs the form that creates one.
  const space = useLiveQuery(() => db.syncSpace.get('singleton').then((row) => row ?? null), [], undefined);
  const [passphrase, setPassphrase] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>({ kind: 'none' });
  const [copied, setCopied] = useState(false);

  async function start() {
    if (passphrase.length < MIN_PASSPHRASE) return setNotice({ kind: 'weak' });
    setBusy(true);
    setNotice({ kind: 'none' });
    try {
      await createSpace(passphrase);
      // Cleared immediately. Nothing else in the app holds it, and neither should a form.
      setPassphrase('');
      await sync();
    } finally {
      setBusy(false);
    }
  }

  async function attachToExisting() {
    if (passphrase.length < MIN_PASSPHRASE) return setNotice({ kind: 'weak' });
    setBusy(true);
    setNotice({ kind: 'none' });
    try {
      const result = await joinSpace(code, passphrase);
      setPassphrase('');
      if (result.kind === 'bad-code') return setNotice({ kind: 'bad-code' });
      if (result.kind === 'wrong-passphrase') return setNotice({ kind: 'wrong-passphrase' });
      if (result.kind === 'offline') return setNotice({ kind: 'offline' });
      setCode('');
      await sync();
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    try {
      const outcome = await runSync();
      setNotice(outcome.kind === 'synced' ? { kind: 'result', outcome } : { kind: 'offline' });
    } finally {
      setBusy(false);
    }
  }

  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  if (space === undefined) return null;

  return (
    <div className="card">
      <span className="card__label">{t('sync.heading')}</span>
      <p className="item__body">{t('sync.explain')}</p>

      {!hasPushIdentity ? (
        <p className="empty">{t('sync.needsPush')}</p>
      ) : !space ? (
        <>
          {/* Said before the field, not after the button. */}
          <p className="field__help">{t('sync.warning')}</p>

          <label className="field">
            <span className="field__label">{t('sync.passphrase')}</span>
            <input
              className="field__input"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              placeholder={t('sync.passphrasePlaceholder')}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>

          <div className="capture__actions">
            <button type="button" className="button" disabled={busy} onClick={() => void start()}>
              {busy ? t('sync.syncing') : t('sync.create')}
            </button>
          </div>

          <span className="section-label">{t('sync.joinHeading')}</span>
          <label className="field">
            <span className="field__label">{t('sync.code')}</span>
            <input
              className="field__input"
              value={code}
              placeholder={t('sync.codePlaceholder')}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <div className="capture__actions">
            <button
              type="button"
              className="button button--quiet"
              disabled={busy || code.trim() === ''}
              onClick={() => void attachToExisting()}
            >
              {t('sync.join')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="item__body">
            {t('sync.on')} ·{' '}
            {space.lastSyncedAt === null
              ? t('sync.lastSynced', { when: t('sync.never') })
              : t('sync.lastSynced', {
                  when: formatRelativeDays(
                    Math.round((space.lastSyncedAt - Date.now()) / DAY_MS),
                    locale,
                  ),
                })}
          </p>

          <span className="section-label">{t('sync.yourCode')}</span>
          <p className="sync-code">{encodeSpaceCode({ spaceId: space.spaceId, salt: space.salt })}</p>
          <p className="field__help">{t('sync.codeSafe')}</p>
          <div className="capture__actions capture__actions--wrap">
            <button
              type="button"
              className="button button--quiet button--small"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(encodeSpaceCode({ spaceId: space.spaceId, salt: space.salt }))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? t('sync.copied') : t('sync.copy')}
            </button>
          </div>

          <div className="capture__actions">
            <button type="button" className="button" disabled={busy} onClick={() => void sync()}>
              {busy ? t('sync.syncing') : t('sync.syncNow')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => void leaveSpace()}
            >
              {t('sync.leave')}
            </button>
          </div>
        </>
      )}

      {notice.kind === 'weak' && <p className="empty">{t('sync.weak')}</p>}
      {notice.kind === 'bad-code' && <p className="empty">{t('sync.badCode')}</p>}
      {notice.kind === 'wrong-passphrase' && <p className="empty">{t('sync.wrongPassphrase')}</p>}
      {notice.kind === 'offline' && <p className="empty">{t('sync.offline')}</p>}

      {notice.kind === 'result' && (
        <ul className="item-list">
          {(
            [
              ['sent', notice.outcome.pushed],
              ['received', notice.outcome.pulled],
              ['conflicts', notice.outcome.conflicts],
              ['undecryptable', notice.outcome.undecryptable],
            ] as const
          )
            // Zeroes are omitted rather than shown: a row saying "0 records could not be decrypted"
            // invites worry about a problem that is not happening.
            .filter(([, value]) => value > 0)
            .map(([key, value]) => (
              <li key={key} className="item item--with-action">
                <span className="item__dot" aria-hidden="true" />
                <span className="item__title">{t(`sync.${key}`)}</span>
                <span className="item__time">{number(value)}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
