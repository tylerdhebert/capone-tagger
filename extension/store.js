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
    for (const [lifecycleId, indices] of Object.entries(shard)) {
      const next = assignmentIndices(indices).filter(tagIndex => tagIndex !== index);
      if (next.length) shard[lifecycleId] = next;
      else delete shard[lifecycleId];
    }
    if (Object.keys(shard).length) updates[key] = shard;
    else emptyShards.push(key);
  }
  await syncSet(updates);
  if (emptyShards.length) await syncRemove(emptyShards);
}

async function getAssignments(entries) {
  const result = new Map();
  const wanted = new Map();
  for (const entry of entries || []) {
    const id = transactionKey(entry);
    if (!id) continue;
    result.set(id, []);
    const key = shardKey(entry.transactionDisplayDate);
    if (!key) continue;
    const ids = wanted.get(key) || new Set();
    ids.add(id);
    wanted.set(key, ids);
  }
  const keys = [...wanted.keys()];
  if (!keys.length) return result;
  const values = await syncGet(keys);
  for (const [key, ids] of wanted) {
    const shard = shardObject(values[key]);
    for (const id of ids) result.set(id, assignmentIndices(shard[id]));
  }
  return result;
}

async function setAssignment(entry, tagIndices) {
  const id = transactionKey(entry);
  if (!id) throw new Error("This transaction has no stable identity to tag");
  const key = shardKey(entry.transactionDisplayDate);
  if (!key) throw new Error("This transaction has no usable display date for storage");
  const next = assignmentIndices(tagIndices);
  const values = await syncGet([key]);
  const shard = shardObject(values[key]);
  if (next.length) shard[id] = next;
  else delete shard[id];
  if (Object.keys(shard).length) await syncSet({ v: 1, [key]: shard });
  else await syncRemove(key);
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
  shardKey, transactionKey, loadTags, createTag, deleteTag,
  getAssignments, setAssignment, prune, exportAll,
  loadRetentionDays, saveRetentionDays, clearAllTags, storageBytesInUse
};
