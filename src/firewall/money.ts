/** Money is integer cents everywhere inside Firstlight. */
export function formatUsd(cents: number): string {
  return `$${toPayPalValue(cents)}`;
}

/** PayPal wants a decimal string such as "80.00". */
export function toPayPalValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
