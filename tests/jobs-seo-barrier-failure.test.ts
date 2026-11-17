import { afterEach, describe, expect, it } from 'vitest';

import { jobsSeoPagesPlugin } from '../build-plugins/jobsSeoPagesPlugin';
import {
  _resetJobsSeoPagesSignalForTests,
  jobsSeoPagesFlushed,
} from '../build-plugins/shared/buildSignals';

afterEach(() => {
  _resetJobsSeoPagesSignalForTests();
});

describe('jobs SEO completion barrier', () => {
  it('releases downstream waits when closeBundle fails before entering its main work', async () => {
    const plugin = jobsSeoPagesPlugin(process.cwd(), { fastLane: true });
    const downstreamWait = jobsSeoPagesFlushed.then(() => 'released');
    const closeBundle = plugin.closeBundle as () => Promise<void>;

    await expect(closeBundle()).rejects.toThrow(
      '[jobs-seo-pages] fastLane requires activeJobIds, fastLaneVisibleJobIdsByLocale, fastLaneDistDir and fastLaneResultFile',
    );
    await expect(downstreamWait).resolves.toBe('released');
  });
});
