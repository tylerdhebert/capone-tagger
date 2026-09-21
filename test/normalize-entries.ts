export function normalizeEntries(payload: unknown): any[] {
  const numericObject = (value: any): any[] | null => {
    if (!value || Array.isArray(value) || typeof value !== "object") return null;
    const keys = Object.keys(value);
    return keys.length && keys.every(key => /^\d+$/.test(key)) ? keys.sort((a, b) => Number(a) - Number(b)).map(key => value[key]) : null;
  };
  const candidate = (value: any): any[] | null => Array.isArray(value) ? value : numericObject(value);
  const valid = (value: any) => { const list = candidate(value); return list && list[0]?.transactionReferenceId ? list : null; };
  const direct = valid(payload); if (direct) return direct;
  if (payload && typeof payload === "object") for (const child of Object.values(payload as object)) {
    const one = valid(child); if (one) return one;
    if (child && typeof child === "object") for (const grandchild of Object.values(child as object)) { const two = valid(grandchild); if (two) return two; }
  }
  console.warn("CapOne Tagger: could not find transaction entries in response payload"); return [];
}
