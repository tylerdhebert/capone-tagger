const retentionDays = document.querySelector("#retention-days"), status = document.querySelector("#status"), storageUsed = document.querySelector("#storage-used");
const store = globalThis.caponeTaggerStore;
function showError(error) { console.error("CapOne Tagger:", error); status.textContent = error instanceof Error ? error.message : String(error); }
async function refreshStorageUsed() {
  const bytes = await store.storageBytesInUse();
  storageUsed.textContent = bytes == null ? "Storage used: unavailable" : `Storage used: approximately ${bytes.toLocaleString()} bytes of about 100 KB`;
}
if (!store) {
  showError(new Error("store.js did not load"));
} else {
  store.loadRetentionDays().then(days => { retentionDays.value = String(days); }).catch(showError);
  refreshStorageUsed();
}
document.querySelector("#save").addEventListener("click", async () => {
  try { await store.saveRetentionDays(retentionDays.value); status.textContent = "Saved."; await refreshStorageUsed(); }
  catch (error) { showError(error); }
});
document.querySelector("#export").addEventListener("click", async () => {
  try {
    const blob = new Blob([JSON.stringify(await store.exportAll(), null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = "capone-tagger-tags.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0); status.textContent = "Exported.";
  } catch (error) { showError(error); }
});
document.querySelector("#clear").addEventListener("click", async () => {
  if (!confirm("Clear all tags everywhere?")) return;
  try { await store.clearAllTags(); status.textContent = "All tags cleared."; await refreshStorageUsed(); }
  catch (error) { showError(error); }
});
