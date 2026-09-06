import { expect, it } from 'vitest';
import { leanLanguage } from './leanLanguage';
it('all Monarch rules compile with the actual Unicode language flag',()=>{
  for(const rules of Object.values(leanLanguage.tokenizer))for(const rule of rules){if(Array.isArray(rule)&&rule[0] instanceof RegExp)expect(()=>new RegExp('^(?:'+rule[0].source+')','u')).not.toThrow();}
});
it('uses a push/pop comment state and distinct string state',()=>{
  expect(leanLanguage.tokenizer.comment).toContainEqual([expect.any(RegExp),'comment','@push']);
  expect(leanLanguage.tokenizer.comment).toContainEqual([expect.any(RegExp),'comment','@pop']);
  expect(leanLanguage.tokenizer.root).toContainEqual([expect.any(RegExp),'string','@string']);
  expect(leanLanguage.keywords).toContain('theorem');expect(leanLanguage.keywords).toContain('rfl');
});
