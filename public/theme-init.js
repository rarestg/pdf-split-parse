// Pre-paint theme bootstrap. A blocking same-origin script (CSP forbids inline
// script), loaded in <head> before the app so the right theme is on <html>
// before first paint — no flash. App.tsx then owns the theme at runtime, reading
// the same localStorage key and applying the same class, so its first effect is a
// visual no-op. Key absent = follow the OS ("system").
(function () {
  try {
    var stored = localStorage.getItem('pdf-split-parse:theme');
    var theme = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    var dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch (_) {
    // localStorage/matchMedia unavailable (e.g. privacy mode): fall back to the
    // CSS default (light) rather than break first paint.
  }
})();
