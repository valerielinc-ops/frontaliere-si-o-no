import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('executes the real scope interpreter and RAW contract Node suites in native CI', () => {
  execFileSync(process.execPath, ['--test',
    fileURLToPath(new URL('./native-scope-interpretation.test.mjs', import.meta.url)),
    fileURLToPath(new URL('./native-form-scope-contract.test.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
}, 20_000);
