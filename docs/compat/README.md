# Browser compatibility records

Chrome is measured automatically:
- `apps/web/bench/run.mjs`: the benchmark protocol;
- `bench/smoke.mjs`: end-to-end steps;
- `bench/compat-check.mjs`: this page's automatic checks.

Other browsers are checked by hand with a recording page, because automating Safari requires turning on "Allow Remote Automation", a system setting CHRONOS does not change.

## Recording a manual check in Safari (about 5 minutes)

1. Start the dev server, from the repository root:

   ```bash
   pnpm --dir apps/web dev
   ```

   The data is already built. If `data/build/current` is missing, run `make data` first.

2. In Safari, open **http://localhost:5174/compat.html** and wait for section 1 to fill.

   Note the row **"Accept-Encoding this browser sent"**: it is what the server actually received from Safari. The page then runs:
   - WebGL2;
   - a compile of the exact shader features StrataExtension uses;
   - module workers and `crypto.subtle`;
   - CSS;
   - **Server sent the best encoding offered** (D-031);
   - **Brotli geometry on the wire, at most 3 MiB** (D-024);
   - the caching header.

3. Press **Run app benchmark** and keep the tab in front for about two minutes. It runs the same protocol as Chrome: sweeps, jumps, explore and 343 picks.

4. Open **http://localhost:5174/** in another tab. Mark each checklist item pass, fail or n/a, with a note where useful.

5. Press **Save results**. The dev server writes `docs/compat/<date>-safari-<version>.json`.

   The endpoint accepts only POSTs from this machine, at most 2 MB. If saving fails, use **Download JSON** and put the file in `docs/compat/`.

## Why Safari gets gzip over plain HTTP, and the optional HTTPS check

On `http://localhost` Safari received the 17.24 MiB gzip copy of the geometry instead of the 2.84 MiB brotli copy. The server is not the cause: `bench/delivery-headers.mjs` shows it sends brotli whenever a request offers `br`, on the dev and preview servers.

Browsers advertise `br` only on secure connections. Chrome counts `http://localhost` as secure; Safari evidently did not. Step 2's "Accept-Encoding" row will show exactly what Safari offered.

Testing Safari with brotli needs HTTPS, and HTTPS needs a certificate Safari trusts. That means **a trust change in your keychain, which is your decision.** Nothing below is required; it is only for checking brotli in Safari.

```bash
# a self-signed certificate for localhost, valid 30 days, in a git-ignored folder
mkdir -p apps/web/.cert
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost" -keyout apps/web/.cert/key.pem -out apps/web/.cert/cert.pem
CHRONOS_HTTPS_KEY=apps/web/.cert/key.pem CHRONOS_HTTPS_CERT=apps/web/.cert/cert.pem pnpm --dir apps/web dev
```

Then open **https://localhost:5174/compat.html**. Safari warns that the connection is not private, and continuing asks macOS to trust the certificate. You can remove that trust afterwards in Keychain Access.

## Records

| File | Browser | Result |
|---|---|---|
| *(not saved)* | Safari on this Mac, 2026-11-11 | **Reported, not saved.**<br>• Passed: WebGL2, shader features, module workers, sha256, CSS, immutable caching.<br>• **Failed:** precompressed geometry (gzip, 17.24 MiB on the wire, 43.9 MiB decoded).<br>• Not run: the benchmark and checklist.<br>Run again with the steps above and save. |
| (automated) | Chrome 157 headless | All automatic checks pass. Offers `gzip, deflate, br, zstd` over `http://localhost`; receives brotli, 2.84 MiB. |
