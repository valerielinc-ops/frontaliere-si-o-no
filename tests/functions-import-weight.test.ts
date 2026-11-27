import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every function of the codebase shares one module graph (functions/index.js). The 256 MiB assisted-application
// functions ran out of memory on 26-27/11 ("Memory limit of 256 MiB exceeded with 265 MiB used"), losing a dispatch
// and runner events, with ~40 MiB of native/gRPC libraries loaded statically by every cold start.
const HEAVY = ['sharp', 'pdf-lib', '@pdf-lib/fontkit', '@google-cloud/recaptcha-enterprise', 'stripe'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []
  ));
}

describe('functions module graph weight', () => {
  it('imports no heavy library statically', () => {
    const offenders: string[] = [];
    for (const file of ['functions/index.js', ...sourceFiles('functions/src')]) {
      const text = readFileSync(file, 'utf8');
      for (const name of HEAVY) {
        const pattern = new RegExp(`^\\s*(?:import|export)\\b[^;]*?\\bfrom\\s+['"]${name.replace(/[/@-]/g, '\\$&')}['"]`, 'm');
        if (pattern.test(text)) offenders.push(`${file} -> ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives the two assisted-application functions that run the flow 512 MiB', () => {
    const index = readFileSync('functions/index.js', 'utf8');
    for (const name of ['applyAssistedApplicationRunnerEvent', 'sweepAssistedApplicationAutomation']) {
      const start = index.indexOf(`export const ${name} =`);
      expect(start).toBeGreaterThan(0);
      expect(index.slice(start, start + 400)).toContain("memory: '512MiB'");
    }
  });
});
