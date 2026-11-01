import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ARTICLE_HUB_CARD_LIMIT as rendererCardLimit } from '../packages/articles/engine/articlesHubCards';
import { ARTICLE_HUB_CARD_LIMIT as sharedCardLimit } from '../packages/articles/engine/shared/articleHubCardBudget.mjs';

const watchdogSource = readFileSync(
  resolve(process.cwd(), 'scripts/check-article-hub-landings.mjs'),
  'utf8',
);

describe('article hub card budget contract', () => {
  it('uses the renderer budget as the watchdog default floor', () => {
    expect(rendererCardLimit).toBe(sharedCardLimit);
    expect(sharedCardLimit).toBeGreaterThan(0);
    expect(watchdogSource).toContain(
      "import { ARTICLE_HUB_CARD_LIMIT } from '../packages/articles/engine/shared/articleHubCardBudget.mjs';",
    );
    expect(watchdogSource).toContain(
      'Number(process.env.MIN_CARDS ?? ARTICLE_HUB_CARD_LIMIT)',
    );
    expect(watchdogSource).not.toContain('?? 50');
  });
});
