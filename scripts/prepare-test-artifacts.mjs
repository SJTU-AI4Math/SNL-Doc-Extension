#!/usr/bin/env node

await import('./build-snl-basics-host.mjs');
await import('./build-export-runtime.mjs');
await import('./build-webviews.mjs');
