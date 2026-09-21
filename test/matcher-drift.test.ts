import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { amountParsingCases, matchingCases, type CaseRow } from "./matching-cases";

// This test exists to guard against the shipped matcher (extension/content.js) drifting from the
// hand-copied duplicate exercised by test/match-rows.test.ts. It reads the real extension source
// off disk, extracts the pure-matching block delimited by the "pure-matching:start"/"end" marker
// comments, and runs it directly — no import from the test's own duplicate.

const START_MARKER = "// --- pure-matching:start ---";
const END_MARKER = "// --- pure-matching:end ---";

function extractPureMatchingBlock(source: string): string {
  const startIndex = source.indexOf(START_MARKER);
  if (startIndex === -1) throw new Error(`matcher-drift: could not find "${START_MARKER}" in extension/content.js`);
  const contentStart = source.indexOf("\n", startIndex);
  const endIndex = source.indexOf(END_MARKER, startIndex);
  if (endIndex === -1) throw new Error(`matcher-drift: could not find "${END_MARKER}" in extension/content.js`);
  return source.slice(contentStart + 1, endIndex);
}

type PureMatchingModule = {
  normalizeDescription: (value: unknown) => string;
  parseAmountCents: (value: unknown) => number | null;
  parseSignedAmountCents: (value: unknown) => number | null;
  dateScore: (rowDate: unknown, entryDate: unknown) => number;
  matchRows: (entries: any[], cells: any[]) => [any, any][];
};

function loadPureMatchingModule(): PureMatchingModule {
  const source = readFileSync(join(import.meta.dir, "..", "extension", "content.js"), "utf8");
  const block = extractPureMatchingBlock(source);
  const factory = new Function(
    `${block}\nreturn { normalizeDescription, parseAmountCents, parseSignedAmountCents, rowDateKey, entryDateKey, dateScore, matchRows };`
  );
  return factory();
}

const shipped = loadPureMatchingModule();

function buildRow(caseRow: CaseRow, fns: PureMatchingModule) {
  const amountCents = fns.parseAmountCents(caseRow.amount);
  const signedCents = caseRow.signedAmount !== undefined ? fns.parseSignedAmountCents(caseRow.signedAmount) : amountCents;
  return {
    amountCents,
    signedCents,
    dateKey: caseRow.dateKey ?? null,
    desc: fns.normalizeDescription(caseRow.desc || ""),
    last4: caseRow.last4 || "",
  };
}

test("matcher-drift: markers are present and delimit a non-empty block", () => {
  const source = readFileSync(join(import.meta.dir, "..", "extension", "content.js"), "utf8");
  expect(source).toContain(START_MARKER);
  expect(source).toContain(END_MARKER);
  expect(extractPureMatchingBlock(source).trim().length).toBeGreaterThan(0);
});

for (const testCase of matchingCases) {
  test(`matcher-drift: ${testCase.name}`, () => {
    const entries = testCase.entries;
    const rows = testCase.rows.map(caseRow => buildRow(caseRow, shipped));
    const result = shipped.matchRows(entries, rows).map(([, matchedEntry]) => matchedEntry.transactionReferenceId);
    expect(result).toEqual(testCase.expected);
  });
}

test("matcher-drift: parses displayed amounts as absolute and signed cents", () => {
  expect(amountParsingCases.map(({ input }) => shipped.parseAmountCents(input))).toEqual(amountParsingCases.map(({ amountCents }) => amountCents));
  expect(amountParsingCases.map(({ input }) => shipped.parseSignedAmountCents(input))).toEqual(
    amountParsingCases.map(({ signedAmountCents }) => signedAmountCents)
  );
});
