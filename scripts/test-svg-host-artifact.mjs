import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const module = { exports: {} };
vm.runInNewContext(readFileSync(new URL('../out/svgTemplateHostValidation.js', import.meta.url), 'utf8'), {
  module, exports: module.exports,
  require(name) { throw new Error(`Packaged validator must be standalone, not require ${name}`); }
});
const validate = module.exports.validateSvgTemplateForPersistence;
validate('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g data-snl-slot="0"/></svg>');
assert.throws(() => validate('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script/></svg>'));
console.log('PASS: compiled host validator accepts safe SVG, rejects script, and needs no external modules');
