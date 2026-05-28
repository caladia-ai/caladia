import { createEngineWorkerClient, type EngineWorkerClient } from '@procsim/engine-worker';

/**
 * Singleton engine worker client.
 *
 * The Worker is created lazily on first call so that modules that import this
 * file (e.g. tests) don't fail in non-browser environments.
 *
 * The worker is persistent — one instance per page load, reused for all
 * schedule and simulate calls.
 *
 * Phase 50 Slice 8 / audit C-7: if the underlying Worker fires an `error`
 * event, the client marks itself dead, terminates the worker, and invokes
 * the `onWorkerError` callback we hand it on construction. The callback
 * nulls `_client` so the next `getEngineWorker()` call lazily spawns a
 * fresh client + Worker. Without this, the singleton retained the
 * poisoned worker and every subsequent call hung forever.
 */
let _client: EngineWorkerClient | null = null;

export function getEngineWorker(): EngineWorkerClient {
  // Defensive: if a previous caller still holds a reference to the old
  // client and it just died, treat the singleton slot as empty.
  if (_client && _client.isDead()) {
    _client = null;
  }
  if (!_client) {
    _client = createEngineWorkerClient(
      new Worker(
        // Vite resolves the package export and bundles dist/worker.js as a
        // separate worker chunk (works with both dev server and production build).
        new URL('@procsim/engine-worker/worker', import.meta.url),
        { type: 'module' },
      ),
      {
        onWorkerError: () => {
          _client = null;
        },
      },
    );
  }
  return _client;
}
