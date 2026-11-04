// Pre-paint theme bootstrap. A blocking same-origin script (CSP forbids inline
// script), loaded in <head> before the app so the right theme is on <html>
// before first paint — no flash. App.tsx then owns the theme at runtime, reading
// the same localStorage key and applying the same class, so its first effect is a
// visual no-op. Key absent = follow the OS ("system").
(() => {
  // Read the stored choice in its OWN try: if storage is blocked (privacy mode),
  // fall back to "system" and still honor the OS preference below — don't let a
  // storage error skip the matchMedia check and flash light on a dark OS.
  let theme = 'system';
  try {
    const stored = localStorage.getItem('pdf-split-parse:theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') theme = stored;
  } catch (_) {
    /* storage blocked — keep "system" */
  }
  try {
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch (_) {
    /* matchMedia/DOM unavailable — the CSS default (light) stands */
  }
})();
