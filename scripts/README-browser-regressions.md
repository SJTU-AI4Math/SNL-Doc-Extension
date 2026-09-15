# Production-browser regression probes

These optional probes preserve the collapsible-preview, saved-Relationship CRUD/CAS,
and local Reader refresh regressions. They exercise production bundles with the
controlled adapters documented in each script; they do not certify an installed
VS Code host, Windows, or the Toolkit production server.

Use a committed revision and an exclusively owned, disposable directory outside
this checkout. Install the repository's locked development dependencies first.
`browser-author-overlay.py` requires Python with `tarfile`'s `filter='data'` support;
it creates a non-Git source snapshot and borrows `node_modules` read-only. Do not
run npm installation inside that snapshot. Build and browser commands should be
serialized and run with bounded native worker pools.

The Playwright probes require `playwright-core` and an existing Chromium executable.
Set `SNL_PLAYWRIGHT_PATH` to a separately installed module path if it is not locally
resolvable, and set `SNL_CHROMIUM_PATH` to the executable. `playwright-core` does not
download a browser. This workflow has been exercised with Node 24 and Python 3.11;
it is not a cross-platform acceptance claim.

```sh
python3 scripts/browser-author-overlay.py /absolute/private/evidence HEAD
cd /absolute/private/evidence/source
export SNL_AUTHOR_EVIDENCE=/absolute/private/evidence
export NODE_OPTIONS='--v8-pool-size=1'
export UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1 TOKIO_WORKER_THREADS=1 GOMAXPROCS=1
# Set SNL_CHROMIUM_PATH and, when needed, SNL_PLAYWRIGHT_PATH here.

# Reader + CreateEntry collapsible behavior; four independent mutations and restoration.
node scripts/test-collapsible-production-mutations.mjs

# Dashboard → actual registered Host/storage → Relationship editor.
SNL_AUTHOR_ENTRIES=dashboard,createRelationship node scripts/browser-author-build.mjs
node node_modules/vitest/vitest.mjs run --config scripts/test-relationship-production-browser.config.mjs --configLoader runner

# HTTP/SSE refresh against the production Reader and Node ESM materializer.
node scripts/build-local-reader.mjs --out author-local
node scripts/test-local-reader-author.mjs
```

Keep output and screenshots outside the maintained checkout. Match bundle/source
hashes to the tested revision and require successful exit codes plus the recorded
assertions. Startup failures, incomplete process cleanup, and an earlier passing
revision are not acceptance of a new integrated tree. Use a short browser temporary
path when the durable evidence directory is long.
