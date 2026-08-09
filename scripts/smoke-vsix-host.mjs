import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const vsix = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(vsix)) {
  console.error('usage: node scripts/smoke-vsix-host.mjs <extension.vsix>');
  process.exit(2);
}

const directory = mkdtempSync(join(tmpdir(), 'snl-doc-vsix-smoke-'));
function walkFiles(directoryPath) {
  return readdirSync(directoryPath).flatMap((name) => {
    const path = join(directoryPath, name);
    return statSync(path).isDirectory() ? walkFiles(path) : [path];
  });
}
try {
  let unzip = spawnSync('unzip', ['-q', vsix, '-d', directory], { encoding: 'utf8' });
  if (unzip.error?.code === 'ENOENT') {
    const python = String.raw`import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`;
    for (const command of ['python3', 'python', 'py']) {
      unzip = spawnSync(command, ['-c', python, vsix, directory], { encoding: 'utf8' });
      if (!unzip.error || unzip.error.code !== 'ENOENT') break;
    }
  }
  if (unzip.status !== 0) {
    throw new Error(unzip.stderr || unzip.error?.message || 'VSIX extraction failed');
  }
  const extension = join(directory, 'extension');
  const required = [
    'out/extension.js',
    'out/snlDoc.js',
    'out/snl-basics-host.cjs',
    'node_modules/@sjtu-ai4math/snl-basics/package.json',
    'node_modules/@sjtu-ai4math/snl-basics/dist-lib/index.js',
    'node_modules/@sjtu-ai4math/snl-basics/dist-lib/core.js',
    'node_modules/@sjtu-ai4math/snl-basics/dist-lib/runtime.js',
    'node_modules/fuse.js/dist/fuse.cjs',
  ];
  for (const file of required) {
    if (!existsSync(join(extension, file))) throw new Error(`VSIX is missing ${file}`);
  }
  const directEsmRequires = walkFiles(join(extension, 'out'))
    .filter((file) => file.endsWith('.js'))
    .filter((file) => /require\(["']@sjtu-ai4math\/snl-basics/.test(readFileSync(file, 'utf8')));
  if (directEsmRequires.length > 0) {
    throw new Error(`CommonJS host output directly requires ESM-only SNL-Basics: ${directEsmRequires.join(', ')}`);
  }
  const basicsChunks = join(
    extension,
    'node_modules/@sjtu-ai4math/snl-basics/dist-lib/chunks'
  );
  if (!existsSync(basicsChunks) || !readdirSync(basicsChunks).some((file) => file.endsWith('.js'))) {
    throw new Error('VSIX is missing the SNL-Basics root-entry runtime chunks');
  }

  const loader = String.raw`
    const Module = require('node:module');
    const original = Module._load;
    const stub = new Proxy(function () { return stub }, {
      get: (_target, key) => key === 'then' ? undefined : stub,
      apply: () => stub,
      construct: () => stub,
    });
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return stub;
      return original.call(this, request, parent, isMain);
    };
    require(process.argv[1]);
    require(process.argv[2]);
    require(process.argv[3]);
    require(process.argv[4]);
  `;
  const load = spawnSync(process.execPath, [
    '-e', loader,
    join(extension, 'out/extension.js'),
    join(extension, 'out/snlDoc.js'),
    join(extension, 'out/dataMigrations.js'),
    join(extension, 'out/snooglSearch.js'),
  ], { encoding: 'utf8' });
  if (load.status !== 0) throw new Error(load.stderr || load.stdout || 'host module load failed');
  console.log(`VSIX host dependency smoke passed: ${vsix}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
