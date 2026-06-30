/**
 * Tiny opt-in debug logger for diagnosing main-thread stalls / timing.
 *
 * Off by default (zero overhead, no console noise). Turn on in the browser console with:
 *   localStorage.setItem('pdf-debug', '1')   // then reload
 * and off with:
 *   localStorage.removeItem('pdf-debug')
 */
const enabled = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('pdf-debug') === '1';
  } catch {
    return false;
  }
})();

export const debugEnabled = enabled;

export function debugLog(...args: unknown[]): void {
  if (enabled) console.log('[pdf]', ...args);
}

/**
 * Start a timer; call the returned function to log elapsed ms under `label`.
 * No-op (and returns a no-op) when debugging is disabled.
 */
export function debugTime(label: string): () => void {
  if (!enabled) return () => {};
  const start = performance.now();
  return () => console.log('[pdf]', label, `${(performance.now() - start).toFixed(1)}ms`);
}
