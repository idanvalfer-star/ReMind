/**
 * Turning text into vectors, on the device.
 *
 * **The single most important thing about this module is where the computation happens.** Every
 * commercial embedding API would be one HTTP call and would send the user's notes to somebody else's
 * server, which is the one thing the rest of this codebase is built not to do. So the model runs
 * locally, in WASM, and the note text never leaves.
 *
 * The cost of that decision is honest and large: a multilingual model is roughly 120 MB, downloaded
 * once. It is therefore strictly opt-in, the size is stated before the download starts, and
 * everything degrades to keyword search if it never happens.
 *
 * ## What is verified and what is not
 *
 * The provider is an interface, and every consumer of it is tested against a deterministic fake. The
 * arithmetic, the storage, the staleness detection, the fusion and the fallbacks all have real tests.
 *
 * `loadOnDeviceProvider` — the dynamic import and the model download — is the one part that could not
 * be executed where this was written: the sandbox blocks the model host. It is small and it is the
 * only unverified code in the feature, and it is written so that a failure surfaces as a message on
 * the settings screen rather than a broken search box.
 */

import { loadSettings } from '../db/settings';

/**
 * A source of embedding vectors.
 *
 * Deliberately narrow. Anything satisfying this can be swapped in — including the fake used in tests
 * and, if someone ever wants it, a server-side embedder they host themselves.
 */
export interface EmbeddingProvider {
  /**
   * Stable identifier, stored alongside every vector.
   *
   * Vectors from different models are not comparable, so this is what lets a model change invalidate
   * the index instead of silently returning nonsense.
   */
  readonly model: string;
  readonly dimensions: number;
  /** Batched, because model invocation overhead dominates for short texts. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * The model.
 *
 * `multilingual-e5-small` because Hebrew is not negotiable here — half the point of this app is that
 * it works in both languages, and the small English-only models that would be a 23 MB download are
 * useless for the Hebrew half. 384 dimensions, int8-quantised.
 */
export const ON_DEVICE_MODEL = 'Xenova/multilingual-e5-small';
export const ON_DEVICE_DIMENSIONS = 384;

/** Stated in the UI before anything is downloaded. Approximate, and deliberately rounded up. */
export const ON_DEVICE_DOWNLOAD_MB = 130;

/**
 * E5 models are trained with asymmetric prefixes and get noticeably worse without them.
 *
 * `query:` for the thing being searched for, `passage:` for the things being searched. Omitting these
 * is the most common way to make an E5 model appear mediocre.
 */
export const QUERY_PREFIX = 'query: ';
export const PASSAGE_PREFIX = 'passage: ';

export class EmbeddingUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`on-device embedding model unavailable: ${String(cause)}`);
    this.name = 'EmbeddingUnavailableError';
  }
}

/** Progress while the model downloads, so a 130 MB wait can show something honest. */
export type LoadProgress = (fraction: number) => void;

let cached: Promise<EmbeddingProvider> | null = null;

/**
 * Loads the on-device model, caching the promise so concurrent callers share one download.
 *
 * The import is dynamic so that neither the library nor its WASM runtime is in the launch bundle. A
 * user who never enables semantic search pays nothing for it — which matters, because "launch to
 * capture under one second" is a requirement and several megabytes of ONNX runtime would end that.
 */
export function loadOnDeviceProvider(onProgress?: LoadProgress): Promise<EmbeddingProvider> {
  cached ??= createOnDeviceProvider(onProgress).catch((cause) => {
    // Do not cache a failure: a download interrupted by a flaky connection should be retryable
    // without a reload.
    cached = null;
    throw cause instanceof EmbeddingUnavailableError ? cause : new EmbeddingUnavailableError(cause);
  });
  return cached;
}

/** Whether the model has already been loaded in this session. */
export function isProviderLoaded(): boolean {
  return cached !== null;
}

async function createOnDeviceProvider(onProgress?: LoadProgress): Promise<EmbeddingProvider> {
  // Bare specifier in a dynamic import, resolved by the bundler into its own lazy chunk.
  const transformers = await import('@huggingface/transformers');

  const extractor = await transformers.pipeline('feature-extraction', ON_DEVICE_MODEL, {
    dtype: 'q8',
    progress_callback: (report: unknown) => {
      // The shape of this callback varies by event; only the download-progress event carries a
      // percentage, and reading it defensively is cheaper than depending on the union.
      const progress = (report as { progress?: number } | null)?.progress;
      if (typeof progress === 'number') onProgress?.(Math.min(1, Math.max(0, progress / 100)));
    },
  });

  return {
    model: ON_DEVICE_MODEL,
    dimensions: ON_DEVICE_DIMENSIONS,
    async embed(texts) {
      if (texts.length === 0) return [];
      // Mean pooling and L2 normalisation are what turn per-token output into one comparable vector
      // per text. The library does both; doing it by hand is a well-known source of subtly wrong
      // similarity scores.
      const output = await extractor(texts as string[], { pooling: 'mean', normalize: true });
      const flat = output.data as Float32Array;
      const width = flat.length / texts.length;

      return texts.map((_, index) =>
        // `slice` copies, deliberately: the returned rows outlive the tensor's buffer once it is
        // disposed, and a view into freed memory is a bug that shows up much later as garbage.
        new Float32Array(flat.slice(index * width, (index + 1) * width)),
      );
    },
  };
}

/**
 * The provider to search with, or `null`.
 *
 * `null` is the ordinary answer, not a failure: semantic search is off by default. It is also the
 * answer when the model cannot be loaded — evicted by iOS, a download that never finished, an engine
 * without the WASM features it needs — because search must keep working in all of those cases.
 *
 * Loading is deferred to the first search rather than done at launch. The model is large even when
 * cached, and "launch to capture under one second" is a requirement that a multi-megabyte WASM
 * instantiation on the critical path would end.
 */
export async function activeProvider(): Promise<EmbeddingProvider | null> {
  const settings = await loadSettings();
  if (!settings.semanticSearchEnabled) return null;
  try {
    return await loadOnDeviceProvider();
  } catch (cause) {
    console.warn('semantic search unavailable; keyword search stands', cause);
    return null;
  }
}
