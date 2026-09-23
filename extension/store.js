function storageError(action, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Firefox Sync storage could not ${action}: ${detail}`);
}

async function syncGet(keys) {
  try { return await browser.storage.sync.get(keys); }
  catch (error) { throw storageError("read data", error); }
}

async function syncSet(values) {
  try { await browser.storage.sync.set(values); }
  catch (error) { throw storageError("save data", error); }
}

async function syncRemove(keys) {
  try { await browser.storage.sync.remove(keys); }
  catch (error) { throw storageError("remove data", error); }
}

function shardKey(displayDate) {
  const date = new Date(displayDate || "");
  if (Number.isNaN(date.getTime())) return null;
  return `a_${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function namesFrom(values) {
  return Array.isArray(values.tagNames) ? values.tagNames.map(name => typeof name === "string" ? name : null) : [];
}

function assignmentIndices(indices) {
  return [...new Set((Array.isArray(indices) ? indices : []).filter(index => Number.isInteger(index) && index >= 0))];
}

// A shard value is either a bare array of tag indices (written before 0.2.0) or
// { t: indices, a: signed amount in cents when a tag was last added,
//   k: amount in cents the user marked as reviewed (optional, since 0.3.0) }.
const emptyRecord = () => ({ tags: [], amountCents: null, reviewedCents: null });

function readRecord(value) {
  if (Array.isArray(value)) return { ...emptyRecord(), tags: assignmentIndices(value) };
  if (!value || typeof value !== "object") return emptyRecord();
  return { tags: assignmentIndices(value.t), amountCents: Number.isInteger(value.a) ? value.a : null, reviewedCents: Number.isInteger(value.k) ? value.k : null };
}

function writeRecord(record) {
  if (record.amountCents === null) return record.tags;
  return record.reviewedCents === null ? { t: record.tags, a: record.amountCents } : { t: record.tags, a: record.amountCents, k: record.reviewedCents };
}

// A transaction's own month first, then the months either side. A pending transaction that posts
// with a date in the next month keeps its lifecycle id, so its record may sit one shard away.
function candidateShardKeys(displayDate) {
  const own = shardKey(displayDate);
  if (!own) return [];
  const [, year, month] = /^a_(\d{4})-(\d{2})$/.exec(own);
  const offset = delta => { const date = new Date(Number(year), Number(month) - 1 + delta, 1); return `a_${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; };
  return [own, offset(-1), offset(1)];
}

function findRecord(shards, keys, id) {
  for (const key of keys) {
    const shard = shards.get(key);
    if (shard && Object.hasOwn(shard, id)) return readRecord(shard[id]);
  }
  return emptyRecord();
}

function amountCents(entry) {
  const raw = entry?.transactionAmount;
  if (raw === undefined || raw === null || raw === "") return null;
  const cents = Math.round(Number(raw) * 100);
  return Number.isFinite(cents) ? cents : null;
}

function isShardKey(key) { return /^a_\d{4}-\d{2}$/.test(key); }
function shardObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}; }

function normalizeDescriptionForKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

// Small deterministic non-cryptographic hash (FNV-1a, 32-bit) — synchronous, stable across
// page loads and machines. Not for security use, only for a short collision-resistant suffix.
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// Real transactionLifecycleId values are plain digit strings from Capital One's API, so the
// "f_" prefix guarantees a synthetic fallback key can never collide with a real one.
function transactionKey(entry) {
  const lifecycleId = entry?.transactionLifecycleId;
  if (lifecycleId !== undefined && lifecycleId !== null && String(lifecycleId) !== "") return String(lifecycleId);
  const date = new Date(entry?.transactionDisplayDate || "");
  if (Number.isNaN(date.getTime())) return null;
  const cents = Math.round(Math.abs(Number(entry?.transactionAmount)) * 100);
  if (!Number.isFinite(cents)) return null;
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const hash = fnv1a(normalizeDescriptionForKey(entry?.transactionDescription));
  return `f_${dateStr}_${cents}_${hash}`;
}

async function loadTags() {
  return { names: namesFrom(await syncGet({ tagNames: [] })) };
}

async function createTag(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Tag names cannot be empty");
  if (trimmed.length > 100) throw new Error("Tag names cannot exceed 100 characters");
  const values = await syncGet({ tagNames: [] });
  const names = namesFrom(values);
  const existing = names.findIndex(value => value !== null && value.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  if (existing >= 0) return { index: existing, names };
  names.push(trimmed);
  await syncSet({ v: 1, tagNames: names });
  return { index: names.length - 1, names };
}

async function deleteTag(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error("Tag index must be a non-negative integer");
  const values = await syncGet(null);
  const names = namesFrom(values);
  if (index >= names.length || names[index] === null) return;
  names[index] = null;
  const updates = { v: 1, tagNames: names };
  const emptyShards = [];
  for (const [key, value] of Object.entries(values)) {
    if (!isShardKey(key)) continue;
    const shard = shardObject(value);
    for (const [lifecycleId, value] of Object.entries(shard)) {
      const record = readRecord(value);
      record.tags = record.tags.filter(tagIndex => tagIndex !== index);
      if (record.tags.length) shard[lifecycleId] = writeRecord(record);
      else delete shard[lifecycleId];
    }
    if (Object.keys(shard).length) updates[key] = shard;
    else emptyShards.push(key);
  }
  await syncSet(updates);
  if (emptyShards.length) await syncRemove(emptyShards);
}

// Resolves to a Map of transaction key -> { tags, amountCents, reviewedCents }.
async function getAssignments(entries) {
  const result = new Map();
  const planned = [];
  for (const entry of entries || []) {
    const id = transactionKey(entry);
    if (!id) continue;
    result.set(id, emptyRecord());
    const keys = candidateShardKeys(entry.transactionDisplayDate);
    if (keys.length) planned.push({ id, keys });
  }
  const keys = [...new Set(planned.flatMap(item => item.keys))];
  if (!keys.length) return result;
  const values = await syncGet(keys);
  const shards = new Map(keys.map(key => [key, shardObject(values[key])]));
  for (const { id, keys: candidates } of planned) result.set(id, findRecord(shards, candidates, id));
  return result;
}

// Read-modify-write for many transactions with one read and one write, so changes that share a
// shard cannot overwrite each other. compute(previousRecord, item) returns the record to store;
// a record with no tags is deleted. Each record is written to its transaction's own month and
// removed from the neighbouring months, which moves records left behind by a date change.
// Resolves to a Map of transaction key -> the record now stored.
async function updateRecords(items, compute) {
  const planned = (items || []).map(item => {
    const id = transactionKey(item.entry);
    if (!id) throw new Error("This transaction has no stable identity to tag");
    const keys = candidateShardKeys(item.entry.transactionDisplayDate);
    if (!keys.length) throw new Error("This transaction has no usable display date for storage");
    return { id, keys, item };
  });
  const result = new Map();
  if (!planned.length) return result;
  const allKeys = [...new Set(planned.flatMap(change => change.keys))];
  const values = await syncGet(allKeys);
  const shards = new Map(allKeys.map(key => [key, shardObject(values[key])])), dirty = new Set();
  for (const { id, keys, item } of planned) {
    const record = compute(findRecord(shards, keys, id), item);
    for (const key of keys) if (Object.hasOwn(shards.get(key), id)) { delete shards.get(key)[id]; dirty.add(key); }
    if (record.tags.length) { shards.get(keys[0])[id] = writeRecord(record); dirty.add(keys[0]); }
    result.set(id, record);
  }
  const updates = { v: 1 }, emptyShards = [];
  for (const key of dirty) {
    const shard = shards.get(key);
    if (Object.keys(shard).length) updates[key] = shard;
    else emptyShards.push(key);
  }
  if (Object.keys(updates).length > 1) await syncSet(updates);
  if (emptyShards.length) await syncRemove(emptyShards);
  return result;
}

// changes: [{ entry, tagIndices }]. The stored amount is refreshed whenever a change adds a tag the
// transaction did not already have (which also clears any review), and kept when tags are only removed.
function setAssignments(changes) {
  return updateRecords(changes, (previous, { entry, tagIndices }) => {
    const tags = assignmentIndices(tagIndices);
    if (!tags.length) return emptyRecord();
    if (tags.some(index => !previous.tags.includes(index))) return { tags, amountCents: amountCents(entry), reviewedCents: null };
    return { ...previous, tags };
  });
}

// Marks each tagged transaction's current amount as reviewed, which silences the changed-amount
// warning until the amount changes again. The amount recorded at tagging time is kept.
function reviewAmounts(entries) {
  return updateRecords((entries || []).map(entry => ({ entry })), (previous, { entry }) =>
    previous.tags.length && previous.amountCents !== null ? { ...previous, reviewedCents: amountCents(entry) } : previous);
}

async function setAssignment(entry, tagIndices) {
  const result = await setAssignments([{ entry, tagIndices }]);
  return result.get(transactionKey(entry));
}

async function prune(retentionDays, now = Date.now()) {
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 0) throw new Error("Retention days must be a non-negative integer");
  const cutoff = new Date(Number(now) - days * 24 * 60 * 60 * 1000);
  const values = await syncGet(null);
  const old = Object.keys(values).filter(key => {
    if (!isShardKey(key)) return false;
    const [, year, month] = /^a_(\d{4})-(\d{2})$/.exec(key);
    return new Date(Number(year), Number(month), 0, 23, 59, 59, 999) < cutoff;
  });
  if (old.length) await syncRemove(old);
  return old.length;
}

async function exportAll() {
  const values = await syncGet(null);
  const output = { v: Number.isInteger(values.v) ? values.v : 1, tagNames: namesFrom(values), retentionDays: Number.isInteger(values.retentionDays) ? values.retentionDays : 150 };
  for (const [key, value] of Object.entries(values)) if (isShardKey(key)) output[key] = shardObject(value);
  return output;
}

async function loadRetentionDays() {
  const values = await syncGet({ retentionDays: 150 });
  return Number.isInteger(values.retentionDays) && values.retentionDays >= 0 ? values.retentionDays : 150;
}

async function saveRetentionDays(retentionDays) {
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 0) throw new Error("Retention days must be a non-negative integer");
  await syncSet({ v: 1, retentionDays: days });
  return days;
}

async function clearAllTags() {
  const values = await syncGet(null);
  const shards = Object.keys(values).filter(isShardKey);
  await syncSet({ v: 1, tagNames: [] });
  if (shards.length) await syncRemove(shards);
}

async function storageBytesInUse() {
  try {
    if (typeof browser.storage.sync.getBytesInUse !== "function") return null;
    return await browser.storage.sync.getBytesInUse();
  } catch { return null; }
}

globalThis.caponeTaggerStore = {
  shardKey, transactionKey, amountCents, loadTags, createTag, deleteTag,
  getAssignments, setAssignment, setAssignments, reviewAmounts, prune, exportAll,
  loadRetentionDays, saveRetentionDays, clearAllTags, storageBytesInUse
};
