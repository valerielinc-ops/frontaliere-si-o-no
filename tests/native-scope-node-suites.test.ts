import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
// Static edges select this wrapper when the corresponding pure code changes.
import '../functions/src/lib/nativeScopeInterpretation.js';
import '../functions/src/lib/nativeApplicationPolicy.js';
import '../functions/src/lib/qualificationEvidence.js';
import '../functions/src/lib/nativeAnswerConstraints.js';
import '../functions/src/lib/candidateIdentityContract.js';

it('executes the real scope interpreter and RAW contract Node suites in native CI', () => {
  try { execFileSync(process.execPath, ['--test',
    fileURLToPath(new URL('./native-scope-interpretation.test.mjs', import.meta.url)),
    fileURLToPath(new URL('./native-form-scope-contract.test.mjs', import.meta.url)),
    fileURLToPath(new URL('./candidate-identity-caption-normalization.test.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join('\n'), { cause: error });
  }
}, 20_000);
