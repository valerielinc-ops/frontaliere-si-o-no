import { beforeEach, describe, expect, it } from 'vitest';

const aiModels = await import('../../scripts/lib/ai-models.mjs');

describe('ai-models content-quality failure tracking', () => {
  beforeEach(() => {
    aiModels.resetState();
  });

  it('does not let HTTP success reset malformed-content streaks', () => {
    aiModels.recordModelContentFailure('mistral/ministral-8b-latest');
    aiModels.recordModelSuccess('mistral/ministral-8b-latest');
    aiModels.recordModelContentFailure('mistral/ministral-8b-latest');

    expect(aiModels.getStats().exhaustedModels).toContain('mistral/ministral-8b-latest');
  });

  it('resets the malformed-content streak only after validated content success', () => {
    aiModels.recordModelContentFailure('mistral/ministral-8b-latest');
    aiModels.recordModelContentSuccess('mistral/ministral-8b-latest');
    aiModels.recordModelContentFailure('mistral/ministral-8b-latest');

    expect(aiModels.getStats().exhaustedModels).not.toContain('mistral/ministral-8b-latest');
  });

  it('never bans local/fallback on repeated content failures — last resort when remote chain is exhausted', () => {
    aiModels.recordModelContentFailure('local/fallback');
    aiModels.recordModelContentFailure('local/fallback');
    aiModels.recordModelContentFailure('local/fallback');
    aiModels.recordModelContentFailure('local/fallback');

    expect(aiModels.getStats().exhaustedModels).not.toContain('local/fallback');
  });
});
