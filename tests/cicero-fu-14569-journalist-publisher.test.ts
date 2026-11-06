import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SOURCE = execFileSync('git', ['show', 'HEAD:scripts/publish-journalist-article.mjs'], { encoding: 'utf8' });

describe('FU-2026-10-21-publish-journalist-article — workflow handoff contract', () => {
  it('retains every successful article id for the fast-publish dispatch', () => {
    expect(SOURCE).toContain('const publishedIds = [];');
    expect(SOURCE).toContain('if (result.id) publishedIds.push(result.id);');
    expect(SOURCE).toContain('fs.appendFileSync(githubOutput, `published_ids=${JSON.stringify(publishedIds)}\\n`);');
  });

  it('processes queued documents sequentially because registration mutates shared files', () => {
    const loopStart = SOURCE.indexOf('for (const docSnap of snap.docs)');
    expect(loopStart).toBeGreaterThan(-1);
    const loop = SOURCE.slice(loopStart, SOURCE.indexOf('console.log(`[publish-journalist-article] done', loopStart));
    expect(loop).toContain('await processDoc(db, FieldValue, docSnap)');
    expect(loop).not.toContain('Promise.all');
  });
});
