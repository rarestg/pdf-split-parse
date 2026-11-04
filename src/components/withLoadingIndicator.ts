const SHOW_AFTER_MS = 150;
const SHOW_FOR_AT_LEAST_MS = 450;

/**
 * Runs `work` and tells `setShown` when to show its loading indicator, so the indicator never flashes: fast work
 * shows nothing, and once shown the indicator stays up for a minimum time. Settles when the indicator hides, so the
 * caller can show the result at that same moment.
 */
export async function withLoadingIndicator<T>(work: () => Promise<T>, setShown: (shown: boolean) => void): Promise<T> {
  let shownAt = 0;
  const timer = setTimeout(() => {
    shownAt = performance.now();
    setShown(true);
  }, SHOW_AFTER_MS);
  try {
    return await work();
  } finally {
    clearTimeout(timer);
    if (shownAt) {
      await new Promise((resolve) => setTimeout(resolve, shownAt + SHOW_FOR_AT_LEAST_MS - performance.now()));
      setShown(false);
    }
  }
}
