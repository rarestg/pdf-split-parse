const REPEAT_RUN_THRESHOLD = 200;

/** Flag output that degenerated into a long run of one non-whitespace character — a classic model loop
 *  (e.g. a markdown table separator of thousands of '-'). Returns a human reason, or undefined. */
export function detectRepetition(text: string, threshold = REPEAT_RUN_THRESHOLD): string | undefined {
  const match = new RegExp(`([^\\s])\\1{${threshold - 1},}`).exec(text);
  if (!match) return undefined;
  return `repeated-character run (${match[0].length.toLocaleString()}× "${match[1]}")`;
}
