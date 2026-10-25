/** Fixture carts for the sandbox demo store. The store, not Zaka, decides the final amount. */
export const CARTS = {
  bundle: {
    label: "Weekend bundle",
    items: [
      { name: "Trail running shoes", amountMinor: 7800 },
      { name: "Merino socks (2 pairs)", amountMinor: 2200 },
    ],
  },
  cents: {
    label: "Odd-cents cart",
    items: [
      { name: "Field notebook", amountMinor: 3334 },
      { name: "Fountain pen", amountMinor: 6667 },
    ],
  },
  large: {
    label: "Bigger basket",
    items: [
      { name: "Lightweight tent", amountMinor: 24900 },
      { name: "Sleeping mat", amountMinor: 8950 },
    ],
  },
} as const;

export type CartKey = keyof typeof CARTS;

export function cartTotal(key: CartKey) {
  return CARTS[key].items.reduce((t, i) => t + i.amountMinor, 0);
}
