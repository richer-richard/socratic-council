/**
 * Dollars as both clients print them: cents from a dime up, four places below
 * that, so a cheap test run does not read as free.
 */
export function usd(n: number): string {
  return `$${n.toFixed(n >= 10 ? 1 : n >= 0.1 || n === 0 ? 2 : 4)}`;
}
