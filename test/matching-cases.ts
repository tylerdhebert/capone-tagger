// Data-only behavioural fixtures shared by test/match-rows.test.ts (which exercises its own
// hand-copied duplicate of the matcher) and test/matcher-drift.test.ts (which exercises the real
// pure-matching block extracted from extension/content.js). Both consumers build their own Row
// objects from `CaseRow` using their own copy of parseAmountCents / parseSignedAmountCents /
// normalizeDescription, so this file intentionally contains no matching logic of its own.

export type DateKey = "PENDING" | { month: number; day: number } | null;

export type CaseEntry = {
  transactionReferenceId: string;
  transactionAmount: number;
  transactionDescription?: string;
  transactionDebitCredit?: string;
  transactionDisplayDate?: string;
  transactionState?: string;
  transactingCardLastFour?: string;
};

// Mirrors the shape produced by the row() helper in the original test file: `amount` is the
// displayed amount string (parsed with parseAmountCents), `signedAmount` — when provided — is a
// displayed amount string parsed with parseSignedAmountCents to produce row.signedCents; when
// omitted, consumers should default signedCents to the parsed (always non-negative) amountCents,
// exactly like the original helper did.
export type CaseRow = {
  amount: string;
  desc?: string;
  last4?: string;
  dateKey?: DateKey;
  signedAmount?: string;
};

export type MatchingCase = {
  name: string;
  entries: CaseEntry[];
  rows: CaseRow[];
  expected: string[];
};

const entry = (id: string, amount: number, description = "", extra: Partial<CaseEntry> = {}): CaseEntry => ({
  transactionReferenceId: id,
  transactionAmount: amount,
  transactionDescription: description,
  ...extra,
});

const row = (amount: string, desc = "", last4 = "", extra: Partial<CaseRow> = {}): CaseRow => ({
  amount,
  desc,
  last4,
  ...extra,
});

// Fixed point used by the "UTC display date" case below so both consumers see the same
// already-resolved local date, without either of them needing to re-derive it from a Date.
const utcDisplayDate = "2026-09-20T00:30:00Z";
const utcLocalDate = new Date(utcDisplayDate);

export const matchingCases: MatchingCase[] = [
  {
    name: "matches distinct amounts by content when DOM and API order differ",
    entries: [entry("api-second", 20, "Coffee"), entry("api-first", 10, "Books")],
    rows: [row("$10.00", "Books"), row("$20.00", "Coffee")],
    expected: ["api-first", "api-second"],
  },
  {
    name: "matches credits without requiring payment descriptions to agree",
    entries: [entry("payment", 500, "CAPITAL ONE ONLINE PYMT", { transactionDebitCredit: "Credit" })],
    rows: [row("-$500.00", "Payment from Chase")],
    expected: ["payment"],
  },
  {
    name: "uses descriptions to distinguish same-amount charges and prevents double claims",
    entries: [entry("grocer", 12.34, "Market Basket"), entry("fuel", 12.34, "Shell Fuel")],
    rows: [row("$12.34", "Shell Fuel"), row("$12.34", "Market Basket")],
    expected: ["fuel", "grocer"],
  },
  {
    name: "preserves API order for identical amount and description",
    entries: [entry("first", 9.99, "Corner Store"), entry("second", 9.99, "Corner Store")],
    rows: [row("$9.99", "Corner Store"), row("$9.99", "Corner Store")],
    expected: ["first", "second"],
  },
  {
    name: "leaves a DOM row unmatched when its amount is absent from the API",
    entries: [entry("known", 1)],
    rows: [row("$2.00", "Unknown")],
    expected: [],
  },
  {
    name: "matches same-merchant same-amount rows by their dates when API order differs",
    entries: [
      entry("july", 9.99, "Streaming Service", { transactionDisplayDate: "2026-07-19T12:00:00Z" }),
      entry("september", 9.99, "Streaming Service", { transactionDisplayDate: "2026-09-19T12:00:00Z" }),
    ],
    rows: [
      row("$9.99", "Streaming Service", "", { dateKey: { month: 8, day: 19 } }),
      row("$9.99", "Streaming Service", "", { dateKey: { month: 6, day: 19 } }),
    ],
    expected: ["september", "july"],
  },
  {
    name: "matches a payment and purchase of the same magnitude by direction",
    entries: [
      entry("purchase", 123.45, "Electronics", { transactionDebitCredit: "Debit", transactionDisplayDate: "2026-09-19T12:00:00Z" }),
      entry("payment", -123.45, "CAPITAL ONE ONLINE PYMT", { transactionDebitCredit: "Credit", transactionDisplayDate: "2026-09-19T12:00:00Z" }),
    ],
    rows: [
      row("-$123.45", "Payment from Bank", "", { signedAmount: "-$123.45", dateKey: { month: 8, day: 19 } }),
      row("$123.45", "Electronics", "", { dateKey: { month: 8, day: 19 } }),
    ],
    expected: ["payment", "purchase"],
  },
  {
    name: "uses local display dates rather than UTC dates",
    entries: [
      entry("two-weeks-away", 18.5, "Transit", { transactionDisplayDate: "2026-09-05T12:00:00Z" }),
      entry("local-day", 18.5, "Transit", { transactionDisplayDate: utcDisplayDate }),
    ],
    rows: [row("$18.50", "Transit", "", { dateKey: { month: utcLocalDate.getMonth(), day: utcLocalDate.getDate() } })],
    expected: ["local-day"],
  },
  {
    name: "uses a one-day date match when it is the closest available candidate",
    entries: [entry("one-day-off", 6.48, "Coffee", { transactionDisplayDate: "2026-09-20T12:00:00Z" })],
    rows: [row("$6.48", "Coffee", "", { dateKey: { month: 8, day: 19 } })],
    expected: ["one-day-off"],
  },
  {
    name: "matches pending rows to pending entries before same-amount posted entries",
    entries: [
      entry("posted", 5, "Coffee", { transactionDisplayDate: "2026-09-19T12:00:00Z" }),
      entry("pending", 5, "Coffee", { transactionState: "PENDING" }),
    ],
    rows: [row("$5.00", "Coffee", "", { dateKey: "PENDING" }), row("$5.00", "Coffee", "", { dateKey: { month: 8, day: 19 } })],
    expected: ["pending", "posted"],
  },
  {
    name: "treats December 31 and January 1 as one day apart",
    entries: [
      entry("far-away", 3, "Bakery", { transactionDisplayDate: "2026-06-15T12:00:00Z" }),
      entry("new-year", 3, "Bakery", { transactionDisplayDate: "2026-01-01T12:00:00Z" }),
    ],
    rows: [row("$3.00", "Bakery", "", { dateKey: { month: 11, day: 31 } })],
    expected: ["new-year"],
  },
  {
    name: "keeps a direction-mismatched candidate when no preferred direction exists",
    entries: [entry("only-debit", 42, "Store", { transactionDebitCredit: "Debit" })],
    rows: [row("-$42.00", "Store", "", { signedAmount: "-$42.00" })],
    expected: ["only-debit"],
  },
  {
    name: "consumes distinct entries when two rows share an identical date and amount",
    entries: [
      entry("first", 9.99, "Corner Store", { transactionDisplayDate: "2026-09-19T12:00:00Z" }),
      entry("second", 9.99, "Corner Store", { transactionDisplayDate: "2026-09-19T12:00:00Z" }),
    ],
    rows: [row("$9.99", "Corner Store", "", { dateKey: { month: 8, day: 19 } }), row("$9.99", "Corner Store", "", { dateKey: { month: 8, day: 19 } })],
    expected: ["first", "second"],
  },
];

export type AmountParsingCase = { input: string; amountCents: number; signedAmountCents: number };

export const amountParsingCases: AmountParsingCase[] = [
  { input: "$1,234.56", amountCents: 123456, signedAmountCents: 123456 },
  { input: "-$500.00", amountCents: 50000, signedAmountCents: -50000 },
  { input: "($42.00)", amountCents: 4200, signedAmountCents: -4200 },
  { input: "$0.99", amountCents: 99, signedAmountCents: 99 },
];
