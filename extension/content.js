(() => {
  const store = globalThis.caponeTaggerStore;
  if (!store) {
    console.error("CapOne Tagger: store.js did not load");
    return;
  }
  let latestEntries = [], scheduled, warnedLookupFailure = false, prunedThisPage = false, activeTooltip, activeTooltipButton, activePicker, lastWarnedUnmatched = null, lastWarnedNoKey = null;
  const tagCache = new Map();
  const tagSetQueues = new Map(), tagSetVersions = new Map();
  let allTags = [];
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
  function tooltipText(t) { const address = t.transactionMerchant?.address || {}; return [
    `date: ${formatDate(t.transactionDisplayDate)}`, `amount: ${formatMoney(t.transactionAmount)}`, `description: ${t.transactionDescription || ""}`,
    `merchant: ${t.transactionMerchant?.name || ""}${address.city ? ` — ${address.city}, ${address.stateCode || ""}` : ""}`,
    `card: ${t.transactingCardLastFour || ""}`, `state: ${t.transactionState || ""}`, `category: ${t.displayCategory || ""}`,
    `lifecycle id: ${t.transactionLifecycleId || ""}`, `reference id: ${(t.transactionReferenceId || "").slice(0, 12)}…`
  ].join("\n"); }
  function showTooltip(button, transaction) { if (activePicker?.button === button) return; activeTooltip?.remove(); if (activeTooltipButton) activeTooltipButton._cptTooltip = null; const tip = document.createElement("div"); tip.className = "cpt-tooltip"; tip.textContent = tooltipText(transaction); tip.setAttribute("role", "tooltip"); document.body.append(tip); const rect = button.getBoundingClientRect(); const height = tip.offsetHeight; const above = rect.bottom + height + 10 > innerHeight; tip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tip.offsetWidth - 8))}px`; tip.style.top = `${above ? Math.max(8, rect.top - height - 8) : rect.bottom + 8}px`; button._cptTooltip = tip; activeTooltip = tip; activeTooltipButton = button; }
  function hideTooltip(button) { button._cptTooltip?.remove(); if (activeTooltipButton === button) { activeTooltip = null; activeTooltipButton = null; } button._cptTooltip = null; }
  function paint(button, tags) {
    const visible = tags.slice(0, 3);
    button.replaceChildren();
    button.classList.toggle("cpt-untagged", !tags.length);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", String(activePicker?.button === button));
    button.setAttribute("aria-label", tags.length ? `Edit tags: ${tags.map(tag => tag.name).join(", ")}` : "Edit tags");
    if (!tags.length) { button.textContent = "+ tag"; return; }
    for (const tag of visible) { const chip = document.createElement("span"); chip.className = "cpt-tag-chip"; chip.textContent = tag.name; button.append(chip); }
    if (tags.length > visible.length) { const more = document.createElement("span"); more.className = "cpt-tag-chip cpt-more-chip"; more.textContent = `+${tags.length - visible.length}`; button.append(more); }
  }
  const cachedTags = key => tagCache.get(key) || [];
  function updateBadge(button, tags) { paint(button, tags); }
  function updateAllBadges() { document.querySelectorAll(".cpt-badge").forEach(button => { const key = store.transactionKey(button._cptTransaction); if (key) updateBadge(button, cachedTags(key)); }); }
  async function refreshTags() {
    const { names } = await store.loadTags();
    allTags = names.map((name, id) => name === null ? null : { id, name }).filter(Boolean);
    return allTags;
  }
  function positionPicker(picker, button) {
    const rect = button.getBoundingClientRect(), height = picker.offsetHeight;
    const above = rect.bottom + height + 10 > innerHeight;
    picker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - picker.offsetWidth - 8))}px`;
    picker.style.top = `${above ? Math.max(8, rect.top - height - 8) : rect.bottom + 8}px`;
  }
  async function setTagIds(picker, nextIds) {
    const key = store.transactionKey(picker.transaction), previous = cachedTags(key);
    const next = allTags.filter(tag => nextIds.has(tag.id));
    const version = (tagSetVersions.get(key) || 0) + 1;
    tagSetVersions.set(key, version);
    tagCache.set(key, next); updateBadge(picker.button, next); renderPicker(picker);
    const send = async () => {
      try {
        await store.setAssignment(picker.transaction, [...nextIds]);
        if (tagSetVersions.get(key) === version) {
          tagCache.set(key, next); updateBadge(picker.button, cachedTags(key)); renderPicker(picker);
        }
      } catch (error) {
        if (tagSetVersions.get(key) === version) {
          tagCache.set(key, previous); updateBadge(picker.button, previous); renderPicker(picker);
        }
        console.error("CapOne Tagger:", error);
      }
    };
    const queued = (tagSetQueues.get(key) || Promise.resolve()).catch(() => undefined).then(send);
    tagSetQueues.set(key, queued);
    queued.finally(() => { if (tagSetQueues.get(key) === queued) tagSetQueues.delete(key); });
    return queued;
  }
  function closePicker(restoreFocus = false) {
    const picker = activePicker; if (!picker) return;
    activePicker = null; document.removeEventListener("mousedown", picker.onOutside, true); document.removeEventListener("keydown", picker.onKeydown, true);
    picker.element.remove(); paint(picker.button, cachedTags(store.transactionKey(picker.transaction)));
    if (restoreFocus && picker.button.isConnected) picker.button.focus();
  }
  async function createTagFromPicker(picker) {
    const name = picker.input.value.trim(); if (!name) return;
    const existing = allTags.find(tag => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing) { const ids = new Set(cachedTags(store.transactionKey(picker.transaction)).map(tag => tag.id)); ids.has(existing.id) ? ids.delete(existing.id) : ids.add(existing.id); await setTagIds(picker, ids); return; }
    try {
      const created = await store.createTag(name);
      allTags = created.names.map((tagName, id) => tagName === null ? null : { id, name: tagName }).filter(Boolean);
      const ids = new Set(cachedTags(store.transactionKey(picker.transaction)).map(tag => tag.id)); ids.add(created.index);
      picker.input.value = ""; await setTagIds(picker, ids);
    } catch (error) { console.error("CapOne Tagger:", error); }
  }
  function renderPicker(picker) {
    if (activePicker !== picker) return;
    const query = picker.input.value.trim().toLocaleLowerCase(), current = new Set(cachedTags(store.transactionKey(picker.transaction)).map(tag => tag.id));
    picker.list.replaceChildren();
    const exact = allTags.find(tag => tag.name.toLocaleLowerCase() === query);
    if (query && !exact) { const create = document.createElement("button"); create.type = "button"; create.className = "cpt-picker-create"; create.textContent = `Create "${picker.input.value.trim()}"`; create.addEventListener("click", () => createTagFromPicker(picker)); picker.list.append(create); }
    for (const tag of allTags.filter(tag => !query || tag.name.toLocaleLowerCase().includes(query))) {
      const row = document.createElement("div"); row.className = "cpt-picker-row";
      const label = document.createElement("label"), checkbox = document.createElement("input"), text = document.createElement("span");
      checkbox.type = "checkbox"; checkbox.checked = current.has(tag.id); checkbox.addEventListener("change", () => { const ids = new Set(current); checkbox.checked ? ids.add(tag.id) : ids.delete(tag.id); setTagIds(picker, ids); });
      text.textContent = tag.name; label.append(checkbox, text);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "cpt-delete-tag"; remove.setAttribute("aria-label", `Delete tag ${tag.name}`); remove.textContent = "×";
      remove.addEventListener("click", async () => { if (!confirm(`Delete tag "${tag.name}" everywhere?`)) return; try { await store.deleteTag(tag.id); await refreshTags(); } catch (error) { console.error("CapOne Tagger:", error); return; } for (const [lifecycleId, tags] of tagCache) tagCache.set(lifecycleId, tags.filter(item => item.id !== tag.id)); updateAllBadges(); renderPicker(picker); });
      row.append(label, remove); picker.list.append(row);
    }
    positionPicker(picker.element, picker.button);
  }
  async function openPicker(button, transaction) {
    if (activePicker?.button === button) { closePicker(true); return; }
    closePicker(); hideTooltip(button);
    const element = document.createElement("div"); element.className = "cpt-picker"; element.setAttribute("role", "dialog"); element.setAttribute("aria-label", "Edit tags");
    const input = document.createElement("input"); input.type = "text"; input.placeholder = "Filter or create a tag…"; input.className = "cpt-picker-input";
    const list = document.createElement("div"); list.className = "cpt-picker-list"; element.append(input, list); document.body.append(element);
    const picker = { button, transaction, element, input, list, onOutside: null, onKeydown: null };
    picker.onOutside = event => { if (!element.contains(event.target) && !button.contains(event.target)) closePicker(); };
    picker.onKeydown = event => { if (event.key === "Escape") { event.preventDefault(); closePicker(true); } };
    activePicker = picker; document.addEventListener("mousedown", picker.onOutside, true); document.addEventListener("keydown", picker.onKeydown, true);
    input.addEventListener("input", () => renderPicker(picker)); input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); createTagFromPicker(picker); } });
    paint(button, cachedTags(store.transactionKey(transaction)));
    try { await refreshTags(); renderPicker(picker); input.focus(); } catch (error) { console.error("CapOne Tagger:", error); closePicker(); }
  }
  function makeBadge(transaction, tags) {
    const button = document.createElement("button"); button.type = "button"; button.className = "cpt-badge"; button._cptTransaction = transaction; paint(button, tags);
    if (!store.transactionKey(transaction)) { button.disabled = true; button.title = "No stable id for this transaction \u2014 cannot tag"; return button; }
    button.addEventListener("mouseenter", () => showTooltip(button, transaction)); button.addEventListener("mouseleave", () => hideTooltip(button)); button.addEventListener("focus", () => showTooltip(button, transaction)); button.addEventListener("blur", () => hideTooltip(button));
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); openPicker(button, transaction); });
    return button;
  }
  async function inject() {
    if (activeTooltipButton && !activeTooltipButton.isConnected) { activeTooltip?.remove(); activeTooltip = activeTooltipButton = null; }
    if (activePicker && !activePicker.button.isConnected) closePicker();
    if (!latestEntries.length) return;
    const cells = [...document.querySelectorAll("c1-ease-cell.cdk-column-amount")].filter(cell => !cell.matches("c1-ease-header-cell, [role=columnheader]"));
    const rows = cells.map(cell => {
      const row = cell.closest("c1-ease-row, [role=\"row\"]") || cell.parentElement;
      const amount = cell.querySelector("span");
      const card = row?.querySelector("c1-ease-cell.cdk-column-card span")?.textContent || "";
      const last4 = card.match(/(\d{4})\s*$/)?.[1] || "";
      const date = row?.querySelector("c1-ease-cell.cdk-column-date");
      return { cell, amountCents: parseAmountCents(amount?.textContent), signedCents: parseSignedAmountCents(amount?.textContent), dateKey: rowDateKey(date), desc: normalizeDescription(row?.querySelector(".c1-ease-txns-description__description")?.textContent), last4 };
    });
    const pairs = matchRows(latestEntries, rows).filter(([, t]) => t?.transactionReferenceId);
    const matchedCells = new Set(pairs.map(([cell]) => cell));
    for (const cell of cells) if (!matchedCells.has(cell)) { cell.querySelector(":scope > .cpt-badge")?.remove(); delete cell.dataset.caponeTagger; }
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
        for (const [key, indices] of assignments) tagCache.set(key, indices.map(id => allTags.find(tag => tag.id === id)).filter(Boolean));
      }
      storageLoaded = true;
    } catch (error) {
      if (!warnedLookupFailure) { warnedLookupFailure = true; console.error("CapOne Tagger:", error); }
    }
    for (const [cell, transaction] of pairs) {
      const key = store.transactionKey(transaction);
      const id = key || "missing-key";
      const existing = cell.querySelector(":scope > .cpt-badge");
      if (cell.dataset.caponeTagger === id && existing) { updateBadge(existing, key ? cachedTags(key) : []); continue; }
      existing?.remove(); cell.dataset.caponeTagger = id;
      const badge = makeBadge(transaction, key ? cachedTags(key) : []), amount = cell.querySelector("span");
      if (amount) amount.after(badge); else cell.append(badge);
    }
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
