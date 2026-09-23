import { describe, expect, it } from 'vitest';
import {
  deriveCrawlerGroupIdsFromArtifactFiles,
  deriveCrawlerGroupIdsFromContract,
  normalizeCrawlerGroupIds,
} from '../scripts/lib/crawler-generation-group-ids.mjs';

describe('crawler generation group autodiscovery', () => {
  it('derives the complete group set from the generated contract artifacts', () => {
    const contract = {
      groupCount: 3,
      artifacts: [
        { file: 'crawler-group-01.yml' },
        { file: 'crawler-group-02.yml' },
        { file: 'crawler-group-03.yml' },
        { file: 'translate-pending.yml' },
      ],
    };

    expect(deriveCrawlerGroupIdsFromContract(contract)).toEqual(['01', '02', '03']);
  });

  it('rejects a contract whose discovered groups are not a contiguous sequence', () => {
    expect(() => deriveCrawlerGroupIdsFromArtifactFiles([
      { file: 'crawler-group-01.yml' },
      { file: 'crawler-group-03.yml' },
    ])).toThrow(/complete sequence/);
    expect(() => normalizeCrawlerGroupIds(['01', '01'])).toThrow(/unique/);
  });
});
