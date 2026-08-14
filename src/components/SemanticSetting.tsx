/**
 * The switch that turns on search-by-meaning, and the honest disclosure that comes with it.
 *
 * The card says the download size before anything happens. A ~130 MB download that starts because
 * someone tapped a toggle labelled "semantic search" is a feature spending their data allowance on
 * their behalf, and the fact that it then works offline forever does not excuse not asking.
 *
 * The other thing it says plainly is where the computation happens. That is the reason a model is
 * being downloaded at all rather than a request being made to an embedding API, and it is the whole
 * justification for the cost.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { db } from '../db/schema';
import {
  isProviderLoaded,
  loadOnDeviceProvider,
  ON_DEVICE_DOWNLOAD_MB,
  ON_DEVICE_MODEL,
} from '../search/embedding';
import { clearIndex, indexPending, indexStatus, type IndexProgress } from '../search/semantic';

export interface SemanticSettingProps {
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void> | void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading'; fraction: number }
  | { kind: 'indexing'; progress: IndexProgress }
  | { kind: 'failed' };

export function SemanticSetting({ enabled, onChange }: SemanticSettingProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [status, setStatus] = useState<IndexProgress | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    void indexStatus(ON_DEVICE_MODEL).then((progress) => {
      if (!cancelled) setStatus(progress);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, phase.kind]);

  /**
   * Downloads the model if needed and embeds whatever is outstanding.
   *
   * Both halves report progress separately because they fail differently and take different amounts
   * of time: the download is the big wait and can be interrupted, the indexing is proportional to how
   * many notes exist and is resumable.
   */
  async function turnOn() {
    await onChange(true);
    setPhase({ kind: 'downloading', fraction: 0 });
    try {
      const provider = await loadOnDeviceProvider((fraction) =>
        setPhase({ kind: 'downloading', fraction }),
      );
      const total = await db.entries.count();
      setPhase({ kind: 'indexing', progress: { done: 0, total } });
      await indexPending(provider, (progress) => setPhase({ kind: 'indexing', progress }));
      setPhase({ kind: 'idle' });
    } catch {
      // The setting stays on deliberately: the model may simply need a better connection, and
      // reverting it would hide the retry behind having to find the toggle again.
      setPhase({ kind: 'failed' });
    }
  }

  async function turnOff() {
    await onChange(false);
    // The index is derived data for a feature that is now off; keeping several megabytes of floats
    // around for a switch the user has just flipped is not being helpful.
    await clearIndex();
    setPhase({ kind: 'idle' });
  }

  const percent = (fraction: number) =>
    new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(fraction);

  return (
    <div className="card">
      <span className="card__label">{t('semantic.heading')}</span>
      <p className="item__body">{t('semantic.explain')}</p>

      {!enabled && <p className="field__help">{t('semantic.cost', { mb: ON_DEVICE_DOWNLOAD_MB })}</p>}

      {phase.kind === 'downloading' && (
        <p className="item__body">
          {t('semantic.downloading', { percent: percent(phase.fraction) })}
        </p>
      )}
      {phase.kind === 'indexing' && (
        <p className="item__body">
          {t('semantic.indexing', { done: phase.progress.done, total: phase.progress.total })}
        </p>
      )}
      {phase.kind === 'failed' && <p className="empty">{t('semantic.failed')}</p>}

      {enabled && phase.kind === 'idle' && status && (
        <p className="item__body">
          {t('semantic.ready', { done: status.done, total: status.total })}
        </p>
      )}

      {/* The model can be evicted by iOS between sessions. Saying so is better than a search box
          that has quietly stopped finding things by meaning. */}
      {enabled && phase.kind === 'idle' && !isProviderLoaded() && status && status.done > 0 && (
        <p className="field__help">{t('semantic.evicted')}</p>
      )}

      <div className="capture__actions">
        {enabled ? (
          <>
            {status && status.done < status.total && (
              <button type="button" className="button" onClick={() => void turnOn()}>
                {t('semantic.reindex')}
              </button>
            )}
            <button type="button" className="button button--quiet" onClick={() => void turnOff()}>
              {t('semantic.disable')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button"
            disabled={phase.kind === 'downloading' || phase.kind === 'indexing'}
            onClick={() => void turnOn()}
          >
            {t('semantic.enable')}
          </button>
        )}
      </div>
    </div>
  );
}
