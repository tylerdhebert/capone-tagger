import { expect, test } from "bun:test";
import { amountParsingCases, matchingCases, type CaseRow } from "./matching-cases";

type DateKey = "PENDING" | { month: number; day: number } | null;
type Row = { amountCents: number | null; signedCents: number | null; dateKey: DateKey; desc: string; last4: string };
type Entry = { transactionReferenceId: string; transactionAmount: number; transactionDescription?: string; transactionDebitCredit?: string; transactionDisplayDate?: string; transactionState?: string; transactingCardLastFour?: string };
type MatchEntry = { entry: Entry; isCredit: boolean; entryDateKey: DateKey };

// This pure matching logic is duplicated in extension/content.js because the extension remains
// plain, unbundled JavaScript. The duplicate is held to the same behavioural bar as the shipped
// code via test/matching-cases.ts and guarded against silent drift by test/matcher-drift.test.ts,
// which runs these same cases directly against extension/content.js.
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

function buildRow(caseRow: CaseRow): Row {
  const amountCents = parseAmountCents(caseRow.amount);
  const signedCents = caseRow.signedAmount !== undefined ? parseSignedAmountCents(caseRow.signedAmount) : amountCents;
  return { amountCents, signedCents, dateKey: caseRow.dateKey ?? null, desc: normalizeDescription(caseRow.desc || ""), last4: caseRow.last4 || "" };
}

for (const testCase of matchingCases) {
  test(testCase.name, () => {
    const rows = testCase.rows.map(buildRow);
    expect(matchRows(testCase.entries as Entry[], rows).map(([, value]) => value.transactionReferenceId)).toEqual(testCase.expected);
  });
}

test("parses displayed amounts as absolute cents", () => {
  expect(amountParsingCases.map(({ input }) => parseAmountCents(input))).toEqual(amountParsingCases.map(({ amountCents }) => amountCents));
  expect(amountParsingCases.map(({ input }) => parseSignedAmountCents(input))).toEqual(amountParsingCases.map(({ signedAmountCents }) => signedAmountCents));
});
