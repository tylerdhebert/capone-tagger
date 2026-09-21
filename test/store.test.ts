import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Values = Record<string, any>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function makeStore(initial: Values = {}) {
  const data = copy(initial), calls = { get: [] as any[] };
  const sync = {
    async get(keys: any = null) {
      calls.get.push(copy(keys));
      if (keys === null) return copy(data);
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => key in data).map(key => [key, copy(data[key])]));
      if (typeof keys === "string") return keys in data ? { [keys]: copy(data[keys]) } : {};
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, key in data ? copy(data[key]) : copy(fallback)]));
    },
    async set(values: Values) { Object.assign(data, copy(values)); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    async getBytesInUse() { return Buffer.byteLength(JSON.stringify(data)); }
  };
  const source = readFileSync(join(import.meta.dir, "..", "extension", "store.js"), "utf8");
  const api = new Function("browser", `${source}\nreturn globalThis.caponeTaggerStore;`)({ storage: { sync } });
  return { api, data, calls };
}

test("exports its public API on globalThis", () => {
  const { api } = makeStore();
  expect(api).toEqual(expect.objectContaining({
    shardKey: expect.any(Function), loadTags: expect.any(Function), createTag: expect.any(Function), deleteTag: expect.any(Function),
    getAssignments: expect.any(Function), setAssignment: expect.any(Function), prune: expect.any(Function), exportAll: expect.any(Function)
  }));
});

const entry = (lifecycleId: string, displayDate: string) => ({ transactionLifecycleId: lifecycleId, transactionDisplayDate: displayDate });
const payment = (displayDate: string, amount: number, description: string) => ({ transactionDisplayDate: displayDate, transactionAmount: amount, transactionDescription: description });

test("shardKey uses local time and rejects garbage", () => {
  const { api } = makeStore();
  const date = new Date(2026, 3, 2, 12, 0, 0);
  expect(api.shardKey(date.toISOString())).toBe(`a_${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  expect(api.shardKey("not a date")).toBeNull();
});

test("createTag is case-insensitively idempotent", async () => {
  const { api, data } = makeStore();
  expect((await api.createTag("Paid")).index).toBe(0);
  expect((await api.createTag(" paid ")).index).toBe(0);
  expect(data.tagNames).toEqual(["Paid"]);
});

test("deleteTag preserves later indices and strips assignments from every shard", async () => {
  const { api, data } = makeStore({ tagNames: ["one", "two", "three"], a_2026_01: { ignored: [1] }, "a_2026-01": { "100": [0, 1, 2] }, "a_2026-02": { "200": [1], "201": [2] } });
  await api.deleteTag(1);
  expect(data.tagNames).toEqual(["one", null, "three"]);
  expect(data["a_2026-01"]).toEqual({ "100": [0, 2] });
  expect(data["a_2026-02"]).toEqual({ "201": [2] });
});

test("setAssignment replaces tag sets and removes empty transactions and shards", async () => {
  const { api, data } = makeStore();
  const transaction = entry("100000000000001", "2026-04-12T12:00:00");
  await api.setAssignment(transaction, [0, 1]);
  await api.setAssignment(transaction, [2]);
  expect(data["a_2026-04"]).toEqual({ "100000000000001": [2] });
  await api.setAssignment(transaction, []);
  expect(data["a_2026-04"]).toBeUndefined();
});

test("getAssignments reads only shards used by the supplied entries", async () => {
  const { api, calls } = makeStore({ "a_2026-03": { "1": [0] }, "a_2026-04": { "2": [1] }, "a_2020-01": { old: [2] } });
  const assignments = await api.getAssignments([entry("1", "2026-03-10T12:00:00"), entry("2", "2026-04-10T12:00:00")]);
  expect([...assignments.entries()]).toEqual([["1", [0]], ["2", [1]]]);
  expect(calls.get).toEqual([["a_2026-03", "a_2026-04"]]);
});

test("prune removes only shards whose month ended before the cutoff", async () => {
  const boundary = new Date(2026, 4, 31, 23, 59, 59, 999).getTime();
  const { api, data } = makeStore({ "a_2026-04": { old: [0] }, "a_2026-05": { boundary: [0] }, "a_2026-06": { current: [0] } });
  expect(await api.prune(30, boundary + 30 * 24 * 60 * 60 * 1000)).toBe(1);
  expect(data["a_2026-04"]).toBeUndefined();
  expect(data["a_2026-05"]).toEqual({ boundary: [0] });
  expect(data["a_2026-06"]).toEqual({ current: [0] });
});

test("transactionKey returns the lifecycle id unchanged when present", () => {
  const { api } = makeStore();
  const transaction = entry("100000000000001", "2026-04-12T12:00:00");
  expect(api.transactionKey(transaction)).toBe("100000000000001");
});

test("transactionKey derives a stable synthetic key for entries with no lifecycle id", () => {
  const { api } = makeStore();
  const transaction = payment("2026-04-12T00:00:00", 123.45, "CAPITAL ONE ONLINE PYMT");
  const key = api.transactionKey(transaction);
  expect(key).toMatch(/^f_2026-04-12_12345_[0-9a-z]+$/);
  expect(api.transactionKey(transaction)).toBe(key);
  expect(api.transactionKey(copy(transaction))).toBe(key);
});

test("transactionKey synthetic keys differ when date, amount, or description differ", () => {
  const { api } = makeStore();
  const base = payment("2026-04-12T00:00:00", 123.45, "CAPITAL ONE ONLINE PYMT");
  const baseKey = api.transactionKey(base);
  expect(api.transactionKey(payment("2026-04-13T00:00:00", 123.45, "CAPITAL ONE ONLINE PYMT"))).not.toBe(baseKey);
  expect(api.transactionKey(payment("2026-04-12T00:00:00", 395, "CAPITAL ONE ONLINE PYMT"))).not.toBe(baseKey);
  expect(api.transactionKey(payment("2026-04-12T00:00:00", 123.45, "CAPITAL ONE MEMBER FEE"))).not.toBe(baseKey);
});

test("a synthetic-keyed payment round-trips through setAssignment/getAssignments into the right shard", async () => {
  const { api, data } = makeStore();
  const transaction = payment("2026-04-12T00:00:00", 123.45, "CAPITAL ONE ONLINE PYMT");
  const key = api.transactionKey(transaction);
  await api.setAssignment(transaction, [0, 1]);
  expect(data["a_2026-04"]).toEqual({ [key]: [0, 1] });
  const assignments = await api.getAssignments([transaction]);
  expect([...assignments.entries()]).toEqual([[key, [0, 1]]]);
});

test("transactionKey returns null with no lifecycle id and no usable date", () => {
  const { api } = makeStore();
  expect(api.transactionKey({ transactionAmount: 10 })).toBeNull();
  expect(api.transactionKey({ transactionDisplayDate: "not a date", transactionAmount: 10 })).toBeNull();
});

// Deliberate, accepted collision: two same-day payments with identical amount and description
// produce the same synthetic key. Identical same-day payments are rare in practice, and
// disambiguating them (e.g. by row order) would reintroduce the ordering fragility this
// fallback key is meant to avoid.
test("transactionKey deliberately collides for identical same-day payments (accepted)", () => {
  const { api } = makeStore();
  const first = payment("2026-04-12T00:00:00", 123.45, "CAPITAL ONE ONLINE PYMT");
  const second = payment("2026-04-12T00:00:00", 123.45, "CAPITAL ONE ONLINE PYMT");
  expect(api.transactionKey(first)).toBe(api.transactionKey(second));
});

test("a realistic 150-day load stays comfortably below the Sync quota", async () => {
  const { api } = makeStore();
  await api.createTag("groceries");
  await api.createTag("bills");
  await api.createTag("travel");
  for (let index = 0; index < 500; index++) {
    const month = 4 + Math.floor(index / 100);
    await api.setAssignment(entry(String(100000000000001 + index), new Date(2026, month, index % 28 + 1, 12).toISOString()), [index % 3]);
  }
  const exported = await api.exportAll();
  const bytes = Buffer.byteLength(JSON.stringify(exported));
  console.log(`150-day storage size: ${bytes} bytes`);
  expect(bytes).toBeLessThan(100 * 1024);
});
