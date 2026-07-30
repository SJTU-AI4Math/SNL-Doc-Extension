#!/usr/bin/env node
// `tsc` never removes outputs whose sources were deleted or newly excluded.
// Clear the host build first so old *.test.js files cannot linger in out/ and
// look like runtime modules (or be picked up by a VSIX made from a dirty tree).
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
rmSync(resolve(here, '..', 'out'), { recursive: true, force: true });
