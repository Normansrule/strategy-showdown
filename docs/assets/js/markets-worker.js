// Fits the price models and runs the simulations off the main thread (they take a few seconds on long series).
import { fitAll, compareFacts, MODEL_IDS } from '../../engine/models.js';

self.onmessage = ev => {
  // Dedicated-worker messages come only from the page that created this worker (origin '' or our own origin).
  if (ev.origin && ev.origin !== self.location.origin) return;
  const { id, x, nSims, seed } = ev.data;
  try {
    const t0 = performance.now();
    const fits = fitAll(x, MODEL_IDS);
    const cmp = compareFacts(x, fits, { nSims, seed });
    self.postMessage({ id, ok: true, fits, cmp, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
