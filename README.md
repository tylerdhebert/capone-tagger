# CapOne Tagger

CapOne Tagger is a personal Firefox extension for assigning tags to Capital One credit-card transactions. The extension stores tags in Firefox Sync; it has no server, database, token, port, or scheduled task.

## Install

1. In Firefox, open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select the `extension\manifest.json` file in your clone of this repo.
3. Visit the Capital One transactions page and use a transaction badge to create or select tags. Hover or focus a badge to view its matched transaction metadata.

Temporary add-ons disappear when Firefox restarts. For a permanent personal installation, run `web-ext sign --channel=unlisted` with AMO API credentials, then install the signed `.xpi`. Release Firefox requires signed extensions.

## Sync and retention

Firefox replicates tags across machines signed into the same Firefox Account when Sync is enabled. Tags are kept in `browser.storage.sync`, sharded by transaction month. The stable key for each assignment is Capital One's `transactionLifecycleId`; the larger `transactionReferenceId` remains visible in the tooltip but is not used for storage.

The extension options page sets **Retention days** (150 by default). Older monthly shards are removed after the first successful injection on a page. The same page provides **Export tags**, which downloads all tag names and assignments as JSON, and **Clear all tags**, which removes every tag and assignment from Sync.

## Distributing to other machines

This is for self-distribution only — the extension is never published or listed on AMO, only signed via the unlisted channel so release Firefox will install it.

1. **Install tooling** (once): `bun install`

2. **Get AMO API credentials** (once, or whenever the secret is lost):
   - Sign in at [addons.mozilla.org](https://addons.mozilla.org).
   - Go to **Tools → Developer Hub → Manage API Keys** (`https://addons.mozilla.org/developers/addon/api/key/`).
   - Generate a new API key. This produces a JWT issuer and a JWT secret. 2FA is typically required before AMO issues keys, and the secret is shown only once — save it somewhere safe immediately.

3. **Set the credentials as environment variables** for the current PowerShell session:

   ```powershell
   $env:WEB_EXT_API_KEY = "your-jwt-issuer"
   $env:WEB_EXT_API_SECRET = "your-jwt-secret"
   ```

   Do not commit these values or paste them into any file in the repo.

4. **Sign the extension**: `bun run sign`

   The signed `.xpi` is written to `web-ext-artifacts/`.

5. **Every signed upload needs a unique version.** Bump `version` in `extension/manifest.json` before each re-sign — AMO rejects a re-upload of a version it has already seen. Keep `package.json`'s `version` in step with it.

6. **Install on another machine**: open the signed `.xpi` in Firefox — drag it into a Firefox window, or go to **Add-ons Manager → gear icon → Install Add-on From File**. Because it's signed, release Firefox installs it permanently, unlike a temporary `about:debugging` load, which disappears on restart.

Auto-updates for self-distributed add-ons are possible via an `update_url` in `browser_specific_settings.gecko` pointing at a hosted update manifest, but that isn't set up here — re-installing the new `.xpi` after each sign is the intended update flow.

Syncing tags across machines (see above) requires each machine's Firefox profile to be signed into the same Firefox Account with Sync enabled — the shared storage namespace comes from the fixed extension id `capone-tagger@tyler.local` in the manifest, so it stays the same across every signed build.
