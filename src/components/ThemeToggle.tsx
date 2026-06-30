export type Theme = 'light' | 'dark' | 'system';

// Hand-rolled 15px icons (stroke = currentColor) so the toggle needs no icon
// dependency and inherits the active/muted text color of each segment.
function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8Z" />
    </svg>
  );
}

const OPTIONS: { value: Theme; label: string; Icon: () => JSX.Element }[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
];

export function ThemeToggle({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className={`theme-opt${theme === value ? ' active' : ''}`}
          aria-label={label}
          aria-pressed={theme === value}
          title={label}
          onClick={() => onTheme(value)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
