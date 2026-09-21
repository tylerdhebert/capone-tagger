import { expect, test } from "bun:test";
import { normalizeEntries } from "./normalize-entries";

const a = { transactionReferenceId: "a" }, b = { transactionReferenceId: "b" };
test("normalizes array, numeric object, nested payload, and garbage", () => {
  expect(normalizeEntries([a, b])).toEqual([a, b]);
  expect(normalizeEntries({ "10": b, "2": a })).toEqual([a, b]);
  expect(normalizeEntries({ response: { transactions: { "0": a, "1": b } } })).toEqual([a, b]);
  expect(normalizeEntries({ response: { nope: [] } })).toEqual([]);
});
