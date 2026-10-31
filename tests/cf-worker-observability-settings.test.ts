import { describe, expect, it } from 'vitest';
import { withRedactedQueryString } from '../scripts/cf-worker-observability-settings.mjs';

describe('withRedactedQueryString', () => {
  it('enables redaction and preserves the settings owned by wrangler.toml', () => {
    expect(withRedactedQueryString({ enabled: true, head_sampling_rate: 0.1, redact_query_string: false })).toEqual({
      enabled: true,
      head_sampling_rate: 0.1,
      redact_query_string: true,
    });
  });
});
