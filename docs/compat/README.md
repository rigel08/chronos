# Browser compatibility records

Chrome is measured automatically (`apps/web/bench/run.mjs`). Other browsers are checked by hand with a recording page, because automating Safari requires turning on "Allow Remote Automation", a system setting CHRONOS does not change.

## Recording a manual check (about 5 minutes)

1. Build the data and start the dev server:

   ```bash
   make data
   pnpm --dir apps/web dev
   ```

2. In the browser under test, open **http://localhost:5174/compat.html**. It checks, automatically:
   - WebGL2;
   - that the exact shader features StrataExtension uses compile (flat varyings, a constant palette array, std140 uniform blocks);
   - module workers and `crypto.subtle`;
   - CSS `color-mix` and `backdrop-filter`;
   - the content encoding and caching headers of the geometry.
3. Press **Run app benchmark**. It loads the real app in a frame and runs the same protocol as Chrome: sweeps, jumps, explore and 343 picks, in about two minutes.
4. Open the app in another tab (http://localhost:5174/). Mark each item of the checklist pass, fail or n/a, with a note where useful.
5. Press **Save results**. The dev server writes `docs/compat/<date>-<browser>-<version>.json`.

   The endpoint only accepts POSTs from this machine, at most 2 MB. If saving fails, **Download JSON** gives you the same record.

## Records

| File | Browser | Result |
|---|---|---|
| *(none yet)* | Safari 27.0.1 | Waiting for the manual run (milestone 1.3) |
