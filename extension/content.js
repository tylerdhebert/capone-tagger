(() => {
  const store = globalThis.caponeTaggerStore;
  if (!store) {
    console.error("CapOne Tagger: store.js did not load");
    return;
  }
  let latestEntries = [], scheduled, warnedLookupFailure = false, prunedThisPage = false, activeTooltip, activeTooltipButton, activePicker, lastWarnedUnmatched = null, lastWarnedNoKey = null;
  const tagCache = new Map(), amountCache = new Map();
  const tagSetVersions = new Map();
  let writeQueue = Promise.resolve();
  let allTags = [];
  // Multi-select: selected maps transaction key -> transaction. Rows carry data-cpt-key while matched.
  const selected = new Map(), transactionsByKey = new Map();
  let lastHoveredRow = null, bulkBar = null, suppressRowClick = false;
  // --- pure-matching:start --- (mirrored in test/match-rows.test.ts; guarded by test/matcher-drift.test.ts)
  const normalizeDescription = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  function parseAmountCents(value) {
    const text = String(value || "").trim(), negative = /^\(.*\)$/.test(text);
    const number = Number(text.replace(/[^\d.-]/g, ""));
    return Number.isFinite(number) ? Math.round(Math.abs(negative ? -number : number) * 100) : null;
  }
  function parseSignedAmountCents(value) {
    const text = String(value || "").trim(), negative = /^\(.*\)$/.test(text);
    const number = Number(text.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(number)) return null;
    return Math.round((negative ? -Math.abs(number) : number) * 100);
  }
  function rowDateKey(cell) {
    const monthSpan = cell?.querySelector("span.c1-ease-txns-date-and-status__month");
    const daySpan = cell?.querySelector("span.c1-ease-txns-date-and-status__day");
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(monthSpan?.textContent?.trim().toLowerCase());
    const day = Number(daySpan?.textContent?.trim());
    if (month >= 0 && Number.isInteger(day)) return { month, day };
    const status = cell?.querySelector("span.c1-ease-txns-date-and-status__status")?.textContent?.trim();
    return !monthSpan && !daySpan && /^pending$/i.test(status || "") ? "PENDING" : null;
  }
  function entryDateKey(entry) {
    if (entry.transactionState === "PENDING") return "PENDING";
    const date = new Date(entry.transactionDisplayDate || "");
    return Number.isNaN(date.getTime()) ? null : { month: date.getMonth(), day: date.getDate() };
  }
  function dateScore(rowDate, entryDate) {
    if (rowDate === "PENDING" && entryDate === "PENDING") return 0;
    if (!rowDate || !entryDate || rowDate === "PENDING" || entryDate === "PENDING") return 2;
    if (rowDate.month === entryDate.month && rowDate.day === entryDate.day) return 0;
    const monthStarts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const rowDay = monthStarts[rowDate.month] + rowDate.day - 1, entryDay = monthStarts[entryDate.month] + entryDate.day - 1;
    return Math.min(Math.abs(rowDay - entryDay), 365 - Math.abs(rowDay - entryDay)) === 1 ? 1 : 2;
  }
  // This pure matching logic is duplicated in server/match-rows.test.ts so the unbundled extension behavior has regression coverage.
  function matchRows(entries, cells) {
    const pool = new Map();
    for (const entry of entries) {
      const cents = Math.round(Math.abs(Number(entry.transactionAmount)) * 100);
      if (!Number.isFinite(cents)) continue;
      const group = pool.get(cents) || [];
      group.push({ entry, isCredit: entry.transactionDebitCredit === "Credit", entryDateKey: entryDateKey(entry) });
      pool.set(cents, group);
    }
    const matches = [];
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
      matches.push([row.cell || row, candidate.entry]);
    }
    return matches;
  }
  // --- pure-matching:end ---
  function normalizeEntries(payload) {
    const numericObject = value => { if (!value || Array.isArray(value) || typeof value !== "object") return null; const keys = Object.keys(value); return keys.length && keys.every(key => /^\d+$/.test(key)) ? keys.sort((a, b) => Number(a) - Number(b)).map(key => value[key]) : null; };
    const candidate = value => Array.isArray(value) ? value : numericObject(value);
    const valid = value => { const list = candidate(value); return list && list[0]?.transactionReferenceId ? list : null; };
    const direct = valid(payload); if (direct) return direct;
    if (payload && typeof payload === "object") for (const child of Object.values(payload)) { const one = valid(child); if (one) return one; if (child && typeof child === "object") for (const grandchild of Object.values(child)) { const two = valid(grandchild); if (two) return two; } }
    console.warn("CapOne Tagger: could not find transaction entries in response payload"); return [];
  }
  const formatDate = value => { try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return value || ""; } };
  const formatMoney = value => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value || 0);
  const taggedAmount = transaction => { const key = store.transactionKey(transaction); return key ? amountCache.get(key) ?? null : null; };
  // Posted, tagged transactions whose amount changed since a tag was last added (e.g. a tip was added).
  function amountDrift(transaction, tags) {
    if (!tags.length || !transaction || transaction.transactionState === "PENDING") return null;
    const tagged = taggedAmount(transaction), current = store.amountCents(transaction);
    return tagged === null || current === null || tagged === current ? null : { tagged, current };
  }
  function tooltipText(t) { const address = t.transactionMerchant?.address || {}, tagged = taggedAmount(t), current = store.amountCents(t); return [
    `date: ${formatDate(t.transactionDisplayDate)}`, `amount: ${formatMoney(t.transactionAmount)}`,
    ...(tagged === null ? [] : [`amount when tagged: ${formatMoney(tagged / 100)}${current !== null && current !== tagged ? ` (${current > tagged ? "+" : "−"}${formatMoney(Math.abs(current - tagged) / 100)} since)` : ""}`]),
    `description: ${t.transactionDescription || ""}`,
    `merchant: ${t.transactionMerchant?.name || ""}${address.city ? ` — ${address.city}, ${address.stateCode || ""}` : ""}`,
    `card: ${t.transactingCardLastFour || ""}`, `state: ${t.transactionState || ""}`, `category: ${t.displayCategory || ""}`,
    `lifecycle id: ${t.transactionLifecycleId || ""}`, `reference id: ${(t.transactionReferenceId || "").slice(0, 12)}…`
  ].join("\n"); }
  function showTooltip(button) { if (activePicker?.anchor === button) return; activeTooltip?.remove(); if (activeTooltipButton) activeTooltipButton._cptTooltip = null; const tip = document.createElement("div"); tip.className = "cpt-tooltip"; tip.textContent = tooltipText(button._cptTransaction); tip.setAttribute("role", "tooltip"); document.body.append(tip); const rect = button.getBoundingClientRect(); const height = tip.offsetHeight; const above = rect.bottom + height + 10 > innerHeight; tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tip.offsetWidth - 8))}px`; tip.style.top = `${above ? Math.max(8, rect.top - height - 8) : rect.bottom + 8}px`; button._cptTooltip = tip; activeTooltip = tip; activeTooltipButton = button; }
  function hideTooltip(button) { button._cptTooltip?.remove(); if (activeTooltipButton === button) { activeTooltip = null; activeTooltipButton = null; } button._cptTooltip = null; }
  // Icons are built with createElementNS from static shapes; nothing here comes from the page.
  function svgIcon(className, viewBox, shapes, attributes = {}) {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", className); svg.setAttribute("viewBox", viewBox); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
    for (const [tag, attrs] of shapes) { const shape = document.createElementNS(ns, tag); for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value); svg.append(shape); }
    return svg;
  }
  const warningIcon = () => svgIcon("cpt-drift-icon", "0 0 16 16", [
    ["path", { d: "M8 1.6 15.1 14.2H.9Z", fill: "#f5b301", stroke: "#8a6200", "stroke-width": "1", "stroke-linejoin": "round" }],
    ["path", { d: "M8 6.1v3.7", stroke: "#2e2100", "stroke-width": "1.7", "stroke-linecap": "round", fill: "none" }],
    ["circle", { cx: "8", cy: "12", r: "1", fill: "#2e2100" }]
  ]);
  const strokeIcon = { fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" };
  const resetIcon = () => svgIcon("cpt-bulk-icon", "0 0 24 24", [["path", { d: "M4 12a8 8 0 1 0 2.35-5.65" }], ["path", { d: "M6.35 2.2v4.15h4.15" }]], strokeIcon);
  const tagIcon = () => svgIcon("cpt-bulk-icon", "0 0 24 24", [["path", { d: "M3 4.5v6.2a1.5 1.5 0 0 0 .44 1.06l8.8 8.8a1.5 1.5 0 0 0 2.12 0l6.2-6.2a1.5 1.5 0 0 0 0-2.12l-8.8-8.8A1.5 1.5 0 0 0 10.7 3H4.5A1.5 1.5 0 0 0 3 4.5z" }], ["circle", { cx: "7.5", cy: "7.5", r: "1.5" }]], strokeIcon);
  function paint(button, tags) {
    const visible = tags.slice(0, 3), drift = amountDrift(button._cptTransaction, tags);
    button.replaceChildren();
    button.classList.toggle("cpt-untagged", !tags.length);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", String(activePicker?.anchor === button));
    button.setAttribute("aria-label", (tags.length ? `Edit tags: ${tags.map(tag => tag.name).join(", ")}` : "Edit tags") + (drift ? `. Amount changed from ${formatMoney(drift.tagged / 100)} since tagging` : ""));
    if (!tags.length) { button.textContent = "+ tag"; return; }
    if (drift) button.append(warningIcon());
    for (const tag of visible) { const chip = document.createElement("span"); chip.className = "cpt-tag-chip"; chip.textContent = tag.name; button.append(chip); }
    if (tags.length > visible.length) { const more = document.createElement("span"); more.className = "cpt-tag-chip cpt-more-chip"; more.textContent = `+${tags.length - visible.length}`; button.append(more); }
  }
  const cachedTags = key => tagCache.get(key) || [];
  function updateBadge(button, tags) { paint(button, tags); }
  function updateAllBadges() { document.querySelectorAll(".cpt-badge").forEach(button => { const key = store.transactionKey(button._cptTransaction); if (key) updateBadge(button, cachedTags(key)); }); }
  function refreshViews() { updateAllBadges(); if (activePicker) renderPicker(activePicker); }
  async function refreshTags() {
    const { names } = await store.loadTags();
    allTags = names.map((name, id) => name === null ? null : { id, name }).filter(Boolean);
    return allTags;
  }
  function positionPicker(picker, anchor) {
    const rect = anchor.getBoundingClientRect(), height = picker.offsetHeight;
    const above = rect.bottom + height + 10 > innerHeight;
    picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - picker.offsetWidth - 8))}px`;
    picker.style.top = `${above ? Math.max(8, rect.top - height - 8) : rect.bottom + 8}px`;
  }
  // changes: [{ transaction, ids: Set of tag ids }]. Updates the caches optimistically, then writes every
  // change in one storage call. All writes share one queue because changes to different transactions
  // in the same month rewrite the same shard.
  function applyTagChanges(changes) {
    const pending = changes.map(({ transaction, ids }) => {
      const key = store.transactionKey(transaction), version = (tagSetVersions.get(key) || 0) + 1;
      const previousTags = cachedTags(key), previousAmount = amountCache.get(key) ?? null;
      const next = allTags.filter(tag => ids.has(tag.id));
      tagSetVersions.set(key, version); tagCache.set(key, next);
      if (!next.length) amountCache.set(key, null);
      else if (next.some(tag => !previousTags.some(previous => previous.id === tag.id))) amountCache.set(key, store.amountCents(transaction));
      return { key, version, transaction, tagIndices: [...ids], previousTags, previousAmount };
    });
    refreshViews();
    const send = async () => {
      try {
        const records = await store.setAssignments(pending.map(({ transaction, tagIndices }) => ({ entry: transaction, tagIndices })));
        for (const change of pending) if (tagSetVersions.get(change.key) === change.version) amountCache.set(change.key, records.get(change.key)?.amountCents ?? null);
      } catch (error) {
        for (const change of pending) if (tagSetVersions.get(change.key) === change.version) { tagCache.set(change.key, change.previousTags); amountCache.set(change.key, change.previousAmount); }
        console.error("CapOne Tagger:", error);
      }
      refreshViews();
    };
    writeQueue = writeQueue.catch(() => undefined).then(send);
    return writeQueue;
  }
  const tagIdsOf = transaction => new Set(cachedTags(store.transactionKey(transaction)).map(tag => tag.id));
  // Adds (on = true) or removes one tag across every transaction the picker targets.
  function setTagOnTargets(picker, tagId, on) {
    const changes = [];
    for (const transaction of picker.targets()) { const ids = tagIdsOf(transaction); if (ids.has(tagId) === on) continue; on ? ids.add(tagId) : ids.delete(tagId); changes.push({ transaction, ids }); }
    return changes.length ? applyTagChanges(changes) : Promise.resolve();
  }
  const everyTargetHas = (picker, tagId) => { const targets = picker.targets(); return targets.length > 0 && targets.every(transaction => tagIdsOf(transaction).has(tagId)); };
  function closePicker(restoreFocus = false) {
    const picker = activePicker; if (!picker) return;
    activePicker = null; document.removeEventListener("mousedown", picker.onOutside, true); document.removeEventListener("keydown", picker.onKeydown, true);
    picker.element.remove(); updateAllBadges(); updateBulkBar();
    if (restoreFocus && picker.anchor.isConnected) picker.anchor.focus();
  }
  async function createTagFromPicker(picker) {
    const name = picker.input.value.trim(); if (!name) return;
    const existing = allTags.find(tag => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) { await setTagOnTargets(picker, existing.id, !everyTargetHas(picker, existing.id)); return; }
    try {
      const created = await store.createTag(name);
      allTags = created.names.map((tagName, id) => tagName === null ? null : { id, name: tagName }).filter(Boolean);
      picker.input.value = ""; await setTagOnTargets(picker, created.index, true);
    } catch (error) { console.error("CapOne Tagger:", error); }
  }
  function renderPicker(picker) {
    if (activePicker !== picker) return;
    const targets = picker.targets();
    if (!targets.length) { closePicker(); return; }
    const query = picker.input.value.trim().toLocaleLowerCase(), current = targets.map(tagIdsOf);
    picker.heading.hidden = !picker.bulk;
    picker.heading.textContent = `Tagging ${targets.length} selected transaction${targets.length === 1 ? "" : "s"}`;
    picker.list.replaceChildren();
    const exact = allTags.find(tag => tag.name.toLocaleLowerCase() === query);
    if (query && !exact) { const create = document.createElement("button"); create.type = "button"; create.className = "cpt-picker-create"; create.textContent = `Create "${picker.input.value.trim()}"`; create.addEventListener("click", () => createTagFromPicker(picker)); picker.list.append(create); }
    for (const tag of allTags.filter(tag => !query || tag.name.toLocaleLowerCase().includes(query))) {
      const row = document.createElement("div"); row.className = "cpt-picker-row";
      const label = document.createElement("label"), checkbox = document.createElement("input"), text = document.createElement("span");
      const count = current.filter(ids => ids.has(tag.id)).length;
      checkbox.type = "checkbox"; checkbox.checked = count === current.length; checkbox.indeterminate = count > 0 && count < current.length;
      checkbox.addEventListener("change", () => setTagOnTargets(picker, tag.id, checkbox.checked));
      text.textContent = tag.name; label.append(checkbox, text);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "cpt-delete-tag"; remove.setAttribute("aria-label", `Delete tag ${tag.name}`); remove.textContent = "×";
      remove.addEventListener("click", async () => { if (!confirm(`Delete tag "${tag.name}" everywhere?`)) return; try { await store.deleteTag(tag.id); await refreshTags(); } catch (error) { console.error("CapOne Tagger:", error); return; } for (const [lifecycleId, tags] of tagCache) tagCache.set(lifecycleId, tags.filter(item => item.id !== tag.id)); refreshViews(); });
      row.append(label, remove); picker.list.append(row);
    }
    positionPicker(picker.element, picker.anchor);
  }
  // anchor: the element the picker opens from. targets: returns the transactions it edits.
  async function openPicker(anchor, targets, bulk = false) {
    if (activePicker?.anchor === anchor) { closePicker(true); return; }
    closePicker(); hideTooltip(anchor);
    const element = document.createElement("div"); element.className = "cpt-picker"; element.setAttribute("role", "dialog"); element.setAttribute("aria-label", bulk ? "Tag selected transactions" : "Edit tags");
    const heading = document.createElement("div"); heading.className = "cpt-picker-heading"; heading.hidden = true;
    const input = document.createElement("input"); input.type = "text"; input.placeholder = "Filter or create a tag…"; input.className = "cpt-picker-input";
    const list = document.createElement("div"); list.className = "cpt-picker-list"; element.append(heading, input, list); document.body.append(element);
    const picker = { anchor, targets, bulk, element, heading, input, list, onOutside: null, onKeydown: null };
    picker.onOutside = event => { if (!element.contains(event.target) && !anchor.contains(event.target)) { suppressRowClick = true; closePicker(); } };
    picker.onKeydown = event => { if (event.key === "Escape") { event.preventDefault(); closePicker(true); } };
    activePicker = picker; document.addEventListener("mousedown", picker.onOutside, true); document.addEventListener("keydown", picker.onKeydown, true);
    input.addEventListener("input", () => renderPicker(picker)); input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); createTagFromPicker(picker); } });
    updateAllBadges();
    try { await refreshTags(); renderPicker(picker); input.focus(); } catch (error) { console.error("CapOne Tagger:", error); closePicker(); }
  }
  function makeBadge(transaction, tags) {
    const button = document.createElement("button"); button.type = "button"; button.className = "cpt-badge"; button._cptTransaction = transaction; paint(button, tags);
    if (!store.transactionKey(transaction)) { button.disabled = true; button.title = "No stable id for this transaction — cannot tag"; return button; }
    button.addEventListener("mouseenter", () => showTooltip(button)); button.addEventListener("mouseleave", () => hideTooltip(button)); button.addEventListener("focus", () => showTooltip(button)); button.addEventListener("blur", () => hideTooltip(button));
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); openPicker(button, () => [button._cptTransaction]); });
    return button;
  }
  // --- multi-select ---
  const rowOf = cell => cell.closest("c1-ease-row, [role=\"row\"]") || cell.parentElement;
  function forgetRow(row) { if (!row) return; delete row.dataset.cptKey; delete row.dataset.cptSelected; if (lastHoveredRow === row) lastHoveredRow = null; }
  function paintSelection() { document.querySelectorAll("[data-cpt-key]").forEach(row => { if (selected.has(row.dataset.cptKey)) row.dataset.cptSelected = ""; else delete row.dataset.cptSelected; }); }
  function clearSelection() { selected.clear(); paintSelection(); updateBulkBar(); }
  function toggleRow(row) {
    const key = row.dataset.cptKey, transaction = transactionsByKey.get(key); if (!transaction) return;
    selected.has(key) ? selected.delete(key) : selected.set(key, transaction);
    lastHoveredRow = row; paintSelection(); updateBulkBar();
    if (activePicker?.bulk) renderPicker(activePicker);
  }
  function ensureBulkBar() {
    if (bulkBar?.isConnected) return bulkBar;
    const bar = document.createElement("div"); bar.className = "cpt-bulk-bar"; bar.hidden = true; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Selected transactions");
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "cpt-bulk-reset"; reset.append(resetIcon());
    const tag = document.createElement("button"); tag.type = "button"; tag.className = "cpt-bulk-tag"; tag.setAttribute("aria-haspopup", "dialog");
    const count = document.createElement("span"); count.className = "cpt-bulk-count"; tag.append(tagIcon(), count);
    reset.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); closePicker(); clearSelection(); });
    tag.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); openPicker(tag, () => [...selected.values()], true); });
    bar.append(reset, tag); document.body.append(bar);
    bar._cptReset = reset; bar._cptTag = tag; bar._cptCount = count; bulkBar = bar;
    return bar;
  }
  // Floats beside the last hovered row. It holds still while its picker is open so the picker stays attached.
  function updateBulkBar() {
    if (!selected.size) { if (bulkBar) bulkBar.hidden = true; return; }
    const bar = ensureBulkBar(), label = `${selected.size} selected`;
    bar._cptCount.textContent = String(selected.size);
    bar._cptReset.title = `Clear selection (${label})`; bar._cptReset.setAttribute("aria-label", `Clear selection, ${label}`);
    bar._cptTag.title = `Tag ${label}`; bar._cptTag.setAttribute("aria-label", `Tag ${label}`); bar._cptTag.setAttribute("aria-expanded", String(activePicker?.anchor === bar._cptTag));
    if (activePicker?.anchor === bar._cptTag && !bar.hidden) return;
    const row = lastHoveredRow?.isConnected && lastHoveredRow.dataset.cptKey ? lastHoveredRow : document.querySelector("[data-cpt-selected]");
    if (!row) { bar.hidden = true; return; }
    bar.hidden = false;
    const rect = row.getBoundingClientRect();
    bar.style.left = `${Math.max(8, Math.min(rect.right + 8, innerWidth - bar.offsetWidth - 8))}px`;
    bar.style.top = `${rect.top + (rect.height - bar.offsetHeight) / 2}px`;
  }
  let barFrame = 0;
  const scheduleBulkBar = () => { if (!selected.size || barFrame) return; barFrame = requestAnimationFrame(() => { barFrame = 0; updateBulkBar(); }); };
  window.addEventListener("scroll", scheduleBulkBar, { capture: true, passive: true });
  window.addEventListener("resize", scheduleBulkBar, { passive: true });
  document.addEventListener("mouseover", event => {
    const row = typeof event.target?.closest === "function" ? event.target.closest("[data-cpt-key]") : null;
    if (row && row !== lastHoveredRow) { lastHoveredRow = row; scheduleBulkBar(); }
  }, true);
  window.addEventListener("mousedown", () => { suppressRowClick = false; }, true);
  // Capture on window runs before Capital One's own row handlers, so a row click selects instead of opening the row.
  window.addEventListener("click", event => {
    const target = event.target;
    if (event.button !== 0 || typeof target?.closest !== "function") return;
    const row = target.closest("[data-cpt-key]");
    if (!row) { suppressRowClick = false; return; }
    if (target.closest(".cpt-badge, .cpt-picker, .cpt-bulk-bar")) return;
    const native = target.closest("a[href], input, select, textarea");
    if (native && native !== row && row.contains(native)) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    // The click that dismissed a picker should not also toggle a row.
    if (suppressRowClick) { suppressRowClick = false; return; }
    if (!getSelection()?.isCollapsed) return;
    toggleRow(row);
  }, true);
  async function inject() {
    if (activeTooltipButton && !activeTooltipButton.isConnected) { activeTooltip?.remove(); activeTooltip = activeTooltipButton = null; }
    if (activePicker && !activePicker.anchor.isConnected) closePicker();
    if (!latestEntries.length) return;
    const cells = [...document.querySelectorAll("c1-ease-cell.cdk-column-amount")].filter(cell => !cell.matches("c1-ease-header-cell, [role=columnheader]"));
    const rows = cells.map(cell => {
      const row = rowOf(cell);
      const amount = cell.querySelector("span");
      const card = row?.querySelector("c1-ease-cell.cdk-column-card span")?.textContent || "";
      const last4 = card.match(/(\d{4})\s*$/)?.[1] || "";
      const date = row?.querySelector("c1-ease-cell.cdk-column-date");
      return { cell, amountCents: parseAmountCents(amount?.textContent), signedCents: parseSignedAmountCents(amount?.textContent), dateKey: rowDateKey(date), desc: normalizeDescription(row?.querySelector(".c1-ease-txns-description__description")?.textContent), last4 };
    });
    const pairs = matchRows(latestEntries, rows).filter(([, t]) => t?.transactionReferenceId);
    const matchedCells = new Set(pairs.map(([cell]) => cell));
    for (const cell of cells) if (!matchedCells.has(cell)) { cell.querySelector(":scope > .cpt-badge")?.remove(); delete cell.dataset.caponeTagger; forgetRow(rowOf(cell)); }
    const unmatched = cells.length - matchedCells.size;
    if (unmatched && unmatched !== lastWarnedUnmatched) {
      console.warn(`CapOne Tagger: ${unmatched} of ${cells.length} rows could not be matched to an API entry`);
      lastWarnedUnmatched = unmatched;
    }
    const taggablePairs = pairs.filter(([, transaction]) => store.transactionKey(transaction));
    const noKeyEntries = pairs.filter(([, transaction]) => !store.transactionKey(transaction)).map(([, transaction]) => transaction);
    const withoutKey = noKeyEntries.length;
    if (withoutKey && withoutKey !== lastWarnedNoKey) {
      const offenders = noKeyEntries.slice(0, 5).map(transaction => [transaction.transactionDescription, transaction.transactionAmount, transaction.transactionState, transaction.transactionDebitCredit].map(value => String(value ?? "")).join(" | "));
      console.warn(`CapOne Tagger: ${withoutKey} of ${pairs.length} rows have no usable key — ${offenders.join("; ")}`);
      lastWarnedNoKey = withoutKey;
    }
    let storageLoaded = false;
    try {
      await refreshTags();
      const missing = taggablePairs.map(([, transaction]) => transaction).filter(transaction => !tagCache.has(store.transactionKey(transaction)));
      if (missing.length) {
        const assignments = await store.getAssignments(missing);
        for (const [key, record] of assignments) { tagCache.set(key, record.tags.map(id => allTags.find(tag => tag.id === id)).filter(Boolean)); amountCache.set(key, record.amountCents); }
      }
      storageLoaded = true;
    } catch (error) {
      if (!warnedLookupFailure) { warnedLookupFailure = true; console.error("CapOne Tagger:", error); }
    }
    for (const [cell, transaction] of pairs) {
      const key = store.transactionKey(transaction);
      const id = key || "missing-key";
      const row = rowOf(cell);
      if (key && row) { row.dataset.cptKey = key; transactionsByKey.set(key, transaction); if (selected.has(key)) selected.set(key, transaction); }
      else forgetRow(row);
      const existing = cell.querySelector(":scope > .cpt-badge");
      if (cell.dataset.caponeTagger === id && existing) { existing._cptTransaction = transaction; updateBadge(existing, key ? cachedTags(key) : []); continue; }
      existing?.remove(); cell.dataset.caponeTagger = id;
      const badge = makeBadge(transaction, key ? cachedTags(key) : []), amount = cell.querySelector("span");
      if (amount) amount.after(badge); else cell.append(badge);
    }
    paintSelection(); updateBulkBar();
    if (activePicker?.bulk) renderPicker(activePicker);
    if (storageLoaded && !prunedThisPage) {
      prunedThisPage = true;
      try { await store.prune(await store.loadRetentionDays(), Date.now()); }
      catch (error) { console.error("CapOne Tagger:", error); }
    }
  }
  function scheduleInject() { clearTimeout(scheduled); scheduled = setTimeout(() => inject().catch(error => console.error("CapOne Tagger:", error)), 150); }
  window.addEventListener("message", event => { if (event.source !== window || !event.data?.__caponeTagger || event.data.kind !== "transactions") return; latestEntries = normalizeEntries(event.data.payload); scheduleInject(); });
  new MutationObserver(scheduleInject).observe(document.body, { childList: true, subtree: true });
})();
