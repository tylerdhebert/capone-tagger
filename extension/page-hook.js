(() => {
  const matches = input => { try { const url = new URL(input, location.href); return url.hostname === "myaccounts.capitalone.com" && url.pathname.includes("/transactions") && url.search.includes("?"); } catch { return false; } };
  const publish = text => { try { window.postMessage({ __caponeTagger: true, kind: "transactions", payload: JSON.parse(text) }, location.origin); } catch {} };
  try {
    const originalFetch = window.fetch;
    const patchedFetch = function (...args) { const result = originalFetch.apply(this, args); try { if (matches(args[0] instanceof Request ? args[0].url : args[0])) result.then(response => { try { response.clone().text().then(publish).catch(() => {}); } catch {} }).catch(() => {}); } catch {} return result; };
    Object.defineProperty(patchedFetch, "name", { value: originalFetch.name }); Object.defineProperty(patchedFetch, "length", { value: originalFetch.length });
    window.fetch = patchedFetch;
  } catch {}
  try {
    const originalOpen = XMLHttpRequest.prototype.open, originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) { try { this.__cptTransactions = matches(url); } catch {} return originalOpen.call(this, method, url, ...rest); };
    XMLHttpRequest.prototype.send = function (...args) { try { if (this.__cptTransactions) this.addEventListener("load", () => { try { publish(this.responseText); } catch {} }, { once: true }); } catch {} return originalSend.apply(this, args); };
  } catch {}
})();
