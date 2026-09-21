import { expect, test } from "bun:test";

type DateKey = "PENDING" | { month: number; day: number } | null;
type Row = { amountCents: number | null; signedCents: number | null; dateKey: DateKey; desc: string; last4: string };
type Entry = { transactionReferenceId: string; transactionAmount: number; transactionDescription?: string; transactionDebitCredit?: string; transactionDisplayDate?: string; transactionState?: string; transactingCardLastFour?: string };
type MatchEntry = { entry: Entry; isCredit: boolean; entryDateKey: DateKey };

const normalizeDescription = (value: unknown) => String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const parseAmountCents = (value: unknown) => {
  const text = String(value || "").trim(), negative = /^\(.*\)$/.test(text);
  const number = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? Math.round(Math.abs(negative ? -number : number) * 100) : null;
};
const parseSignedAmountCents = (value: unknown) => {
  const text = String(value || "").trim(), negative = /^\(.*\)$/.test(text);
  const number = Number(text.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(number)) return null;
  return Math.round((negative ? -Math.abs(number) : number) * 100);
};
const entryDateKey = (entry: Entry): DateKey => {
  if (entry.transactionState === "PENDING") return "PENDING";
  const date = new Date(entry.transactionDisplayDate || "");
  return Number.isNaN(date.getTime()) ? null : { month: date.getMonth(), day: date.getDate() };
};
const dateScore = (rowDate: DateKey, entryDate: DateKey) => {
  if (rowDate === "PENDING" && entryDate === "PENDING") return 0;
  if (!rowDate || !entryDate || rowDate === "PENDING" || entryDate === "PENDING") return 2;
  if (rowDate.month === entryDate.month && rowDate.day === entryDate.day) return 0;
  const monthStarts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const rowDay = monthStarts[rowDate.month] + rowDate.day - 1, entryDay = monthStarts[entryDate.month] + entryDate.day - 1;
  return Math.min(Math.abs(rowDay - entryDay), 365 - Math.abs(rowDay - entryDay)) === 1 ? 1 : 2;
};
// This pure matching logic is duplicated in extension/content.js because the extension remains plain, unbundled JavaScript.
function matchRows(entries: Entry[], cells: Row[]): [Row, Entry][] {
  const pool = new Map<number, MatchEntry[]>();
  for (const entry of entries) {
    const cents = Math.round(Math.abs(Number(entry.transactionAmount)) * 100);
    if (!Number.isFinite(cents)) continue;
    const group = pool.get(cents) || [];
    group.push({ entry, isCredit: entry.transactionDebitCredit === "Credit", entryDateKey: entryDateKey(entry) });
    pool.set(cents, group);
  }
  const matches: [Row, Entry][] = [];
  for (const row of cells) {
    if (row.amountCents == null) continue;
    const candidates = pool.get(row.amountCents);
    if (!candidates?.length) continue;
    let remaining = candidates;
    if (row.signedCents < 0 || row.signedCents > 0) {
      const directionMatches = remaining.filter(candidate => candidate.isCredit === (row.signedCents < 0));
      if (directionMatches.length) remaining = directionMatches;
    }
    const scores = remaining.map(candidate => dateScore(row.dateKey, candidate.entryDateKey));
    const bestScore = Math.min(...scores);
    const dateMatches = remaining.filter((candidate, index) => scores[index] === bestScore);
    if (dateMatches.length) remaining = dateMatches;
    if (remaining.length > 1 && row.last4) {
      const cardMatches = remaining.filter(candidate => candidate.entry.transactingCardLastFour === row.last4);
      if (cardMatches.length) remaining = cardMatches;
    }
    if (remaining.length > 1) {
      const descriptionMatches = remaining.filter(candidate => {
        if (candidate.isCredit) return true;
        const description = normalizeDescription(candidate.entry.transactionDescription);
        return !!description && !!row.desc && (description.includes(row.desc) || row.desc.includes(description));
      });
      if (descriptionMatches.length) remaining = descriptionMatches;
    }
    const candidate = remaining[0];
    candidates.splice(candidates.indexOf(candidate), 1);
    matches.push([row, candidate.entry]);
  }
  return matches;
}

const row = (amount: string, desc = "", last4 = "", extra: Partial<Row> = {}): Row => {
  const amountCents = parseAmountCents(amount);
  return { amountCents, signedCents: amountCents, dateKey: null, desc: normalizeDescription(desc), last4, ...extra };
};
const entry = (id: string, amount: number, description = "", extra: Partial<Entry> = {}): Entry => ({ transactionReferenceId: id, transactionAmount: amount, transactionDescription: description, ...extra });

test("matches distinct amounts by content when DOM and API order differ", () => {
  const entries = [entry("api-second", 20, "Coffee"), entry("api-first", 10, "Books")];
  expect(matchRows(entries, [row("$10.00", "Books"), row("$20.00", "Coffee")]).map(([, value]) => value.transactionReferenceId)).toEqual(["api-first", "api-second"]);
});
test("matches credits without requiring payment descriptions to agree", () => {
  expect(matchRows([entry("payment", 500, "CAPITAL ONE ONLINE PYMT", { transactionDebitCredit: "Credit" })], [row("-$500.00", "Payment from Chase")]).map(([, value]) => value.transactionReferenceId)).toEqual(["payment"]);
});
test("uses descriptions to distinguish same-amount charges and prevents double claims", () => {
  const entries = [entry("grocer", 12.34, "Market Basket"), entry("fuel", 12.34, "Shell Fuel")];
  expect(matchRows(entries, [row("$12.34", "Shell Fuel"), row("$12.34", "Market Basket")]).map(([, value]) => value.transactionReferenceId)).toEqual(["fuel", "grocer"]);
});
test("preserves API order for identical amount and description", () => {
  const entries = [entry("first", 9.99, "Corner Store"), entry("second", 9.99, "Corner Store")];
  expect(matchRows(entries, [row("$9.99", "Corner Store"), row("$9.99", "Corner Store")]).map(([, value]) => value.transactionReferenceId)).toEqual(["first", "second"]);
});
test("leaves a DOM row unmatched when its amount is absent from the API", () => {
  expect(matchRows([entry("known", 1)], [row("$2.00", "Unknown")])).toEqual([]);
});
test("parses displayed amounts as absolute cents", () => {
  expect(["$1,234.56", "-$500.00", "($42.00)", "$0.99"].map(parseAmountCents)).toEqual([123456, 50000, 4200, 99]);
  expect(["$1,234.56", "-$500.00", "($42.00)", "$0.99"].map(parseSignedAmountCents)).toEqual([123456, -50000, -4200, 99]);
});
test("matches same-merchant same-amount rows by their dates when API order differs", () => {
  const entries = [entry("july", 9.99, "Streaming Service", { transactionDisplayDate: "2026-07-19T12:00:00Z" }), entry("september", 9.99, "Streaming Service", { transactionDisplayDate: "2026-09-19T12:00:00Z" })];
  const rows = [row("$9.99", "Streaming Service", "", { dateKey: { month: 8, day: 19 } }), row("$9.99", "Streaming Service", "", { dateKey: { month: 6, day: 19 } })];
  expect(matchRows(entries, rows).map(([, value]) => value.transactionReferenceId)).toEqual(["september", "july"]);
});
test("matches a payment and purchase of the same magnitude by direction", () => {
  const entries = [entry("purchase", 123.45, "Electronics", { transactionDebitCredit: "Debit", transactionDisplayDate: "2026-09-19T12:00:00Z" }), entry("payment", -123.45, "CAPITAL ONE ONLINE PYMT", { transactionDebitCredit: "Credit", transactionDisplayDate: "2026-09-19T12:00:00Z" })];
  const rows = [row("-$123.45", "Payment from Bank", "", { signedCents: parseSignedAmountCents("-$123.45"), dateKey: { month: 8, day: 19 } }), row("$123.45", "Electronics", "", { dateKey: { month: 8, day: 19 } })];
  expect(matchRows(entries, rows).map(([, value]) => value.transactionReferenceId)).toEqual(["payment", "purchase"]);
});
test("uses local display dates rather than UTC dates", () => {
  const displayDate = "2026-09-20T00:30:00Z", localDate = new Date(displayDate);
  const entries = [entry("two-weeks-away", 18.5, "Transit", { transactionDisplayDate: "2026-09-05T12:00:00Z" }), entry("local-day", 18.5, "Transit", { transactionDisplayDate: displayDate })];
  expect(matchRows(entries, [row("$18.50", "Transit", "", { dateKey: { month: localDate.getMonth(), day: localDate.getDate() } })]).map(([, value]) => value.transactionReferenceId)).toEqual(["local-day"]);
});
test("uses a one-day date match when it is the closest available candidate", () => {
  expect(matchRows([entry("one-day-off", 6.48, "Coffee", { transactionDisplayDate: "2026-09-20T12:00:00Z" })], [row("$6.48", "Coffee", "", { dateKey: { month: 8, day: 19 } })]).map(([, value]) => value.transactionReferenceId)).toEqual(["one-day-off"]);
});
test("matches pending rows to pending entries before same-amount posted entries", () => {
  const entries = [entry("posted", 5, "Coffee", { transactionDisplayDate: "2026-09-19T12:00:00Z" }), entry("pending", 5, "Coffee", { transactionState: "PENDING" })];
  const rows = [row("$5.00", "Coffee", "", { dateKey: "PENDING" }), row("$5.00", "Coffee", "", { dateKey: { month: 8, day: 19 } })];
  expect(matchRows(entries, rows).map(([, value]) => value.transactionReferenceId)).toEqual(["pending", "posted"]);
});
test("treats December 31 and January 1 as one day apart", () => {
  const entries = [entry("far-away", 3, "Bakery", { transactionDisplayDate: "2026-06-15T12:00:00Z" }), entry("new-year", 3, "Bakery", { transactionDisplayDate: "2026-01-01T12:00:00Z" })];
  expect(matchRows(entries, [row("$3.00", "Bakery", "", { dateKey: { month: 11, day: 31 } })]).map(([, value]) => value.transactionReferenceId)).toEqual(["new-year"]);
});
test("keeps a direction-mismatched candidate when no preferred direction exists", () => {
  expect(matchRows([entry("only-debit", 42, "Store", { transactionDebitCredit: "Debit" })], [row("-$42.00", "Store", "", { signedCents: parseSignedAmountCents("-$42.00") })]).map(([, value]) => value.transactionReferenceId)).toEqual(["only-debit"]);
});
test("consumes distinct entries when two rows share an identical date and amount", () => {
  const entries = [entry("first", 9.99, "Corner Store", { transactionDisplayDate: "2026-09-19T12:00:00Z" }), entry("second", 9.99, "Corner Store", { transactionDisplayDate: "2026-09-19T12:00:00Z" })];
  const rows = [row("$9.99", "Corner Store", "", { dateKey: { month: 8, day: 19 } }), row("$9.99", "Corner Store", "", { dateKey: { month: 8, day: 19 } })];
  expect(matchRows(entries, rows).map(([, value]) => value.transactionReferenceId)).toEqual(["first", "second"]);
});
