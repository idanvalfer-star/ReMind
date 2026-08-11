/**
 * Vitest global setup.
 *
 * Installs an in-memory IndexedDB so Dexie works under node. The engine tests are
 * the ones that need it — the parser tests are pure and would pass without it.
 */
import 'fake-indexeddb/auto';
