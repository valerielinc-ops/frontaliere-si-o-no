import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('R2 credential provisioning scope', () => {
  it('keeps only public bucket metadata in the client template and writes the S3 pair privately', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/set-r2-rc.mjs'), 'utf8');
    const clientStageStart = source.indexOf('const clientParams = {');
    const privateStageStart = source.indexOf('const serverResult = await updateRcTemplateWithEtag');
    const outputStart = source.indexOf("console.log(`✅ R2 public metadata updated");
    const clientStage = source.slice(clientStageStart, privateStageStart);
    const privateStage = source.slice(privateStageStart, outputStart);

    expect(source).toContain('namespace: RC_SERVER_NAMESPACE');
    expect(source).toContain("['SERVER_R2_ACCESS_KEY_ID', accessKeyId]");
    expect(source).toContain("['SERVER_R2_SECRET_ACCESS_KEY', secretAccessKey]");
    expect(clientStage).toContain('R2_ACCOUNT_ID');
    expect(clientStage).toContain('R2_BUCKET');
    expect(clientStage).toContain('R2_S3_ENDPOINT');
    expect(clientStage).not.toContain('R2_ACCESS_KEY_ID');
    expect(clientStage).not.toContain('R2_SECRET_ACCESS_KEY');
    expect(privateStage).not.toContain('console.log');
    expect(source).not.toMatch(/accessKeyId\.slice|secretAccessKey\.slice/u);
  });
});
