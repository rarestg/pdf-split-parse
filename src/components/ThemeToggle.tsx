import moonIconUrl from '../icons/moon.svg';
import sunIconUrl from '../icons/sun.svg';

export type ColorScheme = 'light' | 'dark';

export function ThemeToggle({
  colorScheme,
  onChange,
}: {
  colorScheme: ColorScheme;
  onChange: (nextScheme: ColorScheme) => void;
}) {
  const nextScheme = colorScheme === 'light' ? 'dark' : 'light';
  const iconUrl = colorScheme === 'light' ? moonIconUrl : sunIconUrl;

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to ${nextScheme} theme`}
      title={`Switch to ${nextScheme} theme`}
      onClick={() => onChange(nextScheme)}
    >
      <span
        className="theme-icon"
        style={{ WebkitMaskImage: `url("${iconUrl}")`, maskImage: `url("${iconUrl}")` }}
        aria-hidden="true"
      />
    </button>
  );
}
