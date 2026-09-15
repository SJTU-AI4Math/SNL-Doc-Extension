import {defineConfig} from 'vitest/config';
export default defineConfig({cacheDir:'.author-vitest-cache',test:{include:['scripts/test-relationship-production-browser.test.ts'],environment:'node',testTimeout:180000,hookTimeout:30000,maxWorkers:1,fileParallelism:false}});
