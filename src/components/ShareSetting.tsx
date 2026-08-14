/**
 * Shared lists: redeeming an invite, and managing the lists this device already belongs to.
 *
 * Creating a share lives on the Trip screen instead of here — sharing is something you do *to* a
 * particular packing list, and putting the button where that list already is means there is no second
 * place asking "which list do you mean?" Everything that is not tied to one specific trip screen — a
 * pasted invite code, the roster of lists this device is in, minting further invites, removing a member
 * — belongs together in one place, which is here.
 *
 * The one thing this card is careful to say plainly, right where an owner is about to copy an invite:
 * **whoever holds the invite can read the list.** The key travels inside it. There is no way around
 * that and no attempt made to hide it.
 */

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { db, type ShareRole, type SharedList } from '../db/schema';
import {
  leaveSharedList,
  listMembers,
  mintInvite,
  redeemInvite,
  revokeMember,
  runShareSync,
  selfAuthorId,
  type Member,
} from '../share/list';

export interface ShareSettingProps {
  /** Sharing signs its requests with the push identity, exactly as sync does. */
  hasPushIdentity: boolean;
}

type Notice =
  | { kind: 'none' }
  | { kind: 'bad-code' }
  | { kind: 'expired' }
  | { kind: 'already-used' }
  | { kind: 'unknown-code' }
  | { kind: 'offline' }
  | { kind: 'joined' };

export function ShareSetting({ hasPushIdentity }: ShareSettingProps) {
  const { t } = useTranslation();
  const lists = useLiveQuery(() => db.sharedLists.toArray(), [], undefined);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>({ kind: 'none' });
  const [openListId, setOpenListId] = useState<string | null>(null);

  async function redeem() {
    setBusy('redeem');
    setNotice({ kind: 'none' });
    try {
      const result = await redeemInvite(code.trim());
      if (result.kind === 'bad-code') return setNotice({ kind: 'bad-code' });
      if (result.kind === 'expired') return setNotice({ kind: 'expired' });
      if (result.kind === 'already-used') return setNotice({ kind: 'already-used' });
      if (result.kind === 'unknown') return setNotice({ kind: 'unknown-code' });
      if (result.kind === 'offline') return setNotice({ kind: 'offline' });
      setCode('');
      setNotice({ kind: 'joined' });
      await runShareSync(result.list.id);
    } finally {
      setBusy(null);
    }
  }

  async function sync(listId: string) {
    setBusy(listId);
    try {
      await runShareSync(listId);
    } finally {
      setBusy(null);
    }
  }

  async function leave(listId: string) {
    setBusy(listId);
    try {
      await leaveSharedList(listId);
      if (openListId === listId) setOpenListId(null);
    } finally {
      setBusy(null);
    }
  }

  if (!hasPushIdentity) {
    return (
      <div className="card">
        <span className="card__label">{t('share.heading')}</span>
        <p className="empty">{t('share.needsPush')}</p>
      </div>
    );
  }

  if (lists === undefined) return null;

  return (
    <div className="card">
      <span className="card__label">{t('share.heading')}</span>
      <p className="item__body">{t('share.explain')}</p>

      {lists.length > 0 && (
        <ul className="item-list">
          {lists.map((list) => (
            <li key={list.id} className="item item--with-action">
              <span className="item__dot" aria-hidden="true" />
              <span className="item__title">{list.title || t('share.untitled')}</span>
              <span className="item__time">{t(`share.role_${list.role}`)}</span>
            </li>
          ))}
        </ul>
      )}
      {lists.length === 0 && <p className="empty">{t('share.none')}</p>}

      {lists.map((list) =>
        openListId === list.id ? (
          <ListManager
            key={list.id}
            list={list}
            busy={busy === list.id}
            onSync={() => sync(list.id)}
            onLeave={() => leave(list.id)}
            onClose={() => setOpenListId(null)}
          />
        ) : null,
      )}

      {lists.length > 0 && (
        <div className="capture__actions capture__actions--wrap">
          {lists.map((list) => (
            <button
              key={list.id}
              type="button"
              className="button button--quiet button--small"
              onClick={() => setOpenListId(openListId === list.id ? null : list.id)}
            >
              {openListId === list.id ? t('share.hide') : t('share.manage', { title: list.title })}
            </button>
          ))}
        </div>
      )}

      <span className="section-label">{t('share.redeemHeading')}</span>
      <p className="field__help">{t('share.redeemWarning')}</p>
      <label className="field">
        <span className="field__label">{t('share.code')}</span>
        <input
          className="field__input"
          value={code}
          placeholder={t('share.codePlaceholder')}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <div className="capture__actions">
        <button
          type="button"
          className="button button--quiet"
          disabled={busy === 'redeem' || code.trim() === ''}
          onClick={() => void redeem()}
        >
          {busy === 'redeem' ? t('share.joining') : t('share.join')}
        </button>
      </div>

      {notice.kind === 'bad-code' && <p className="empty">{t('share.badCode')}</p>}
      {notice.kind === 'expired' && <p className="empty">{t('share.expired')}</p>}
      {notice.kind === 'already-used' && <p className="empty">{t('share.alreadyUsed')}</p>}
      {notice.kind === 'unknown-code' && <p className="empty">{t('share.unknownCode')}</p>}
      {notice.kind === 'offline' && <p className="empty">{t('sync.offline')}</p>}
      {notice.kind === 'joined' && <p className="item__body">{t('share.joinedNotice')}</p>}
    </div>
  );
}

interface ListManagerProps {
  list: SharedList;
  busy: boolean;
  onSync: () => void;
  onLeave: () => void;
  onClose: () => void;
}

/**
 * Per-list detail: minting invites and managing members. Split out of `ShareSetting` because it does
 * its own async loading (the member roster is not a live query — it comes from the server on demand,
 * since membership is server-side truth this device does not otherwise hold).
 */
function ListManager({ list, busy, onSync, onLeave }: ListManagerProps) {
  const { t } = useTranslation();
  const [role, setRole] = useState<Exclude<ShareRole, 'owner'>>('editor');
  const [invite, setInvite] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [self, setSelf] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isOwner = list.role === 'owner';

  async function mint() {
    setInviting(true);
    setInvite(null);
    try {
      const result = await mintInvite(list.id, role);
      if (result.kind === 'ok') setInvite(result.code);
    } finally {
      setInviting(false);
    }
  }

  async function loadMembers() {
    setLoadingMembers(true);
    try {
      const [list_, own] = await Promise.all([listMembers(list.id), selfAuthorId()]);
      setMembers(list_);
      setSelf(own);
    } finally {
      setLoadingMembers(false);
    }
  }

  async function revoke(author: string) {
    if (await revokeMember(list.id, author)) {
      setMembers((current) => current?.filter((m) => m.author !== author) ?? null);
    }
  }

  return (
    <div className="followup followup--sheet">
      <p className="item__body">
        {list.lastSyncedAt === null ? t('share.neverSynced') : t('share.lastSynced')}
      </p>

      <div className="capture__actions">
        <button type="button" className="button button--quiet button--small" disabled={busy} onClick={onSync}>
          {busy ? t('sync.syncing') : t('sync.syncNow')}
        </button>
        <button type="button" className="button button--quiet button--small" disabled={busy} onClick={onLeave}>
          {isOwner ? t('share.stopSharing') : t('share.leaveList')}
        </button>
      </div>

      {isOwner && (
        <>
          <span className="section-label">{t('share.inviteHeading')}</span>
          <p className="field__help">{t('share.inviteWarning')}</p>
          <div className="capture__actions capture__actions--wrap">
            <select
              className="field__input"
              value={role}
              onChange={(event) => setRole(event.target.value as Exclude<ShareRole, 'owner'>)}
            >
              <option value="editor">{t('share.role_editor')}</option>
              <option value="viewer">{t('share.role_viewer')}</option>
            </select>
            <button type="button" className="button button--small" disabled={inviting} onClick={() => void mint()}>
              {inviting ? t('share.minting') : t('share.invite')}
            </button>
          </div>
          {invite && (
            <>
              <p className="sync-code">{invite}</p>
              <div className="capture__actions">
                <button
                  type="button"
                  className="button button--quiet button--small"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(invite)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                >
                  {copied ? t('sync.copied') : t('sync.copy')}
                </button>
              </div>
            </>
          )}

          <span className="section-label">{t('share.membersHeading')}</span>
          {members === null ? (
            <div className="capture__actions">
              <button
                type="button"
                className="button button--quiet button--small"
                disabled={loadingMembers}
                onClick={() => void loadMembers()}
              >
                {loadingMembers ? t('share.loadingMembers') : t('share.showMembers')}
              </button>
            </div>
          ) : (
            <ul className="item-list">
              {members.map((member) => (
                <li key={member.author} className="item item--with-action">
                  <span className="item__dot" aria-hidden="true" />
                  <span className="item__title">
                    {member.author === self ? t('share.you') : t('share.member')}
                  </span>
                  <span className="item__time">{t(`share.role_${member.role}`)}</span>
                  {member.author !== self && (
                    <button
                      type="button"
                      className="button button--quiet button--small"
                      onClick={() => void revoke(member.author)}
                    >
                      {t('share.remove')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
