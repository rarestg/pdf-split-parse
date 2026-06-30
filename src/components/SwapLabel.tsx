/** A button label that reserves the width of its widest option so the button never jogs. */
export function SwapLabel({ options, children }: { options: readonly string[]; children: string }) {
  return (
    <span className="swap">
      {options.map((label) => (
        <span key={label} className="swap-ghost" aria-hidden="true">
          {label}
        </span>
      ))}
      <span>{children}</span>
    </span>
  );
}
