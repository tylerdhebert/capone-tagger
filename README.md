# CapOne Tagger

A Firefox extension that adds user-defined tags to transactions on the Capital One website. Tags are stored in `browser.storage.sync` and replicate across machines signed into the same Firefox Account.

Requires Firefox 140 or later.

## Install

Open the signed `.xpi` in Firefox: drag it into a window, or **Add-ons Manager → gear icon → Install Add-on From File**.

For development, load `extension/manifest.json` via **Load Temporary Add-on** at `about:debugging#/runtime/this-firefox`. Temporary add-ons are removed when Firefox restarts.

## How it works

`page-hook.js` runs in the page's own JavaScript context and patches `fetch` and `XMLHttpRequest` to read the response of Capital One's `/transactions` API call. It posts the parsed payload to `content.js`, which runs in the extension's isolated context.

### Matching rows to transactions

Transaction rows in the DOM carry no identifier, so `content.js` matches each rendered row to an API entry by content. Rows are read from `c1-ease-cell.cdk-column-amount`, in document order.

Candidates are grouped by absolute amount in cents, then narrowed in order:

1. **Direction** — a negative rendered amount prefers entries where `transactionDebitCredit` is `Credit`.
2. **Date** — scored by proximity: exact day, then ±1 day, then anything else. Pending rows match entries whose `transactionState` is `PENDING`. Dates are compared in local time, since the payload is UTC and the page renders local.
3. **Card last four**, read from the row's card cell.
4. **Description**, normalized. Skipped for credits, whose rendered text (`Payment from <bank>`) does not resemble `transactionDescription` (`CAPITAL ONE ONLINE PYMT`).
5. **API array order**, for anything still tied.

Each narrowing step is skipped if it would eliminate every candidate, so a weak signal can improve a choice but never drops a row to zero matches. Claimed entries are removed from the pool, so two rows cannot resolve to the same transaction. A row that matches nothing gets no badge.

### Transaction keys

`store.transactionKey(entry)` returns the key a tag is stored under:

- `transactionLifecycleId` when present.
- Otherwise `f_<YYYY-MM-DD>_<absolute cents>_<hash of normalized description>`. Capital One's own ledger entries — payments, the annual fee — have no lifecycle id. The hash is FNV-1a in base36, and the `f_` prefix cannot collide with a lifecycle id, which is always digits.
- `null` when neither a lifecycle id nor a usable date and amount exist. Those rows render a disabled badge.

Two ledger entries with the same date, amount and description resolve to the same key.

### Tagging

Clicking a tag badge opens a picker for that one transaction. Hovering it shows the transaction's details, including the amount when it was tagged.

Clicking anywhere else on a matched row selects it, and clicking it again deselects it. Selected rows are highlighted in blue. The click is captured before Capital One's own row handler, so it does not open the row. Clicks with a modifier key held, and clicks on links or form fields inside the row, pass through unchanged. While any row is selected, a toolbar floats beside the last hovered row. It shows the total of the selected transactions (credits count as negative), and has buttons to clear the selection, copy the selection as text, and open the picker for every selected transaction. In that picker a tag shows as checked when all selected transactions have it and as mixed when only some do; checking it adds it to all of them, unchecking removes it from all of them.

The copy button puts one line per selected transaction on the clipboard, rows on screen first in page order:

```
Tipped Restaurant        $60.00
GROCERY STORE            $42.10
Payment from BANK    -$1,100.00
```

Names are the description as the page shows it, padded to the longest; amounts are right-aligned so they line up in a monospaced font.

### Amount changes

Each tagged transaction stores its amount from the last time a tag was added to it; removing tags leaves the stored amount alone. A posted transaction whose current amount differs from the stored one, such as a restaurant charge that posts with the tip added, shows a yellow warning icon beside its tags. Its picker shows both amounts and a **Mark reviewed** button, which silences the warning for the current amount while keeping the original; the tooltip then notes the change as reviewed. The warning returns if the amount changes again, and adding a tag records the new amount and clears the review.

## Storage

| Key | Contents |
|---|---|
| `v` | Schema version |
| `tagNames` | Array of tag names. A tag's id is its index; deleting a tag sets its slot to `null` so other indices stay valid. |
| `a_YYYY-MM` | One shard per calendar month, mapping transaction key to `{ "t": [tag indices], "a": signed amount in cents when a tag was last added, "k": amount in cents marked reviewed (optional) }`. Records written before 0.2.0 are a bare array of tag indices with no amount; they are read as-is and rewritten in the new form when a tag is next added. |
| `retentionDays` | Integer, default 150. |

`browser.storage.sync` allows roughly 100KB total and 8KB per item, which is why shards are per month. All tag writes go through one queue, and the store reads and writes every affected shard once per batch, so changes to several transactions in the same month cannot overwrite each other.

A record is looked up in its transaction's own month and then the months either side, because a transaction tagged while pending can post with a date in the next month. The next write moves it to its current month. Pruning deletes whole shards older than the retention window, and runs once per page load after the first injection.

## Options

Reachable from the Add-ons Manager. Sets retention days, shows bytes used against the quota, exports all tags and assignments as JSON, and clears all stored tags.

## Development

```
bun install
bun test test/
bun run lint
bun run build
```

`matchRows` and its helpers exist twice: in `extension/content.js`, which ships, and in `test/match-rows.test.ts`. The extension is unbundled, so the shipped copy cannot be imported by a test.

`test/matcher-drift.test.ts` reads `extension/content.js` from disk, slices the block between the `pure-matching:start` and `pure-matching:end` markers, and runs it against the shared cases in `test/matching-cases.ts`. `test/match-rows.test.ts` runs its own copy against the same cases. Both copies are therefore held to the same behaviour. Changing the matcher in one place and not the other fails the suite.

## Releasing

1. Bump `version` in `extension/manifest.json` and `package.json`. AMO rejects a version it has already accepted.
2. `bun run build` writes a zip to `web-ext-artifacts/`.
3. Sign it on AMO's unlisted channel, either by uploading the zip or with `bun run sign`, which reads `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` from the environment.
4. Install the signed `.xpi` on each machine.

The extension id `capone-tagger@tyler.local` is fixed in the manifest, so every build shares one storage namespace. There is no `update_url`, so installing a new version means opening the new `.xpi`.
