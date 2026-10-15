// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compactBorderWaitArchiveDay, readBorderWaitArchive, writeBorderWaitArchive } from '../scripts/lib/border-wait-monthly-archive.mjs';
import { generateBorderWaitArchives } from '../build-plugins/borderWaitPagesPlugin';
import { htmlHasIndexableRobots } from '../build-plugins/shared/incrementalHtmlReuse.mjs';
const today = new Date();
const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
const previousDay = new Date(monthStart.getTime() - 86400000).toISOString().slice(0, 10);
const now = today.toISOString().slice(0, 10);
const row = (date = previousDay, avg = 12) => ({ date, perCrossing: { gaggiolo: Array.from({ length: 24 }, () => ({ avg, min: 0, max: 20, samples: 3 })) } });

describe('durable border-wait monthly facts', () => {
  it('indexes an observed zero but not crossings with no observations in the month', () => {
    const pages = generateBorderWaitArchives({ history: [row(previousDay, 0)], today });
    expect(Object.keys(pages)).toHaveLength(20);
    for (const [url, html] of Object.entries(pages)) {
      expect(htmlHasIndexableRobots(html), url).toBe(url.includes('/gaggiolo/'));
      expect(html).toContain(`https://frontaliereticino.ch${url}`);
    }
    const source = fs.readFileSync(new URL('../build-plugins/borderWaitPagesPlugin.ts', import.meta.url), 'utf8');
    const writer = source.slice(source.indexOf('for (const [path, html] of Object.entries(archives))'));
    expect(writer).toContain('if (htmlHasIndexableRobots(html)) sitemapPaths.push(path)');
  });
  it('stages monthly facts in every active workflow that directly invokes a collector entry point', () => {
    const workflowsDir = new URL('../.github/workflows/', import.meta.url);
    const writers = fs.readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file)).map((file) => {
      const workflow = parse(fs.readFileSync(new URL(file, workflowsDir), 'utf8'));
      const commands = Object.values(workflow?.jobs || {}).flatMap((job: any) => (job.steps || []).map((step: any) => step.run).filter((run: unknown): run is string => typeof run === 'string'));
      return { file, commands };
    }).filter(({ commands }) => commands.some((run) => /^\s*node scripts\/(?:collect-traffic|snapshot-border-wait-history)\.mjs\b/m.test(run)));
    expect(writers.length).toBeGreaterThan(0);
    for (const { file, commands } of writers) {
      const stages = commands.flatMap((run) => [...run.matchAll(/\bgit add ([^\n]+)/g)].map((match) => match[1]));
      expect(stages.length, file).toBeGreaterThan(0);
      for (const stage of stages) expect(stage, file).toContain('data/border-wait-archive');
    }
  });

  it('keeps only observed hourly means for archive crossings, including zero', () => {
    const compact = compactBorderWaitArchiveDay({ ...row(previousDay, 0), privateData: 'discard', perCrossing: { ...row(previousDay, 0).perCrossing, unrelated: [{ avg: 999 }] } });
    expect(compact.perCrossing.gaggiolo[0]).toEqual({ avg: 0 });
    expect(Object.keys(compact.perCrossing)).toEqual(['gaggiolo']);
    expect(compact).not.toHaveProperty('privateData');
    expect(compactBorderWaitArchiveDay({ date: previousDay, perCrossing: {} })).toBeNull();
  });

  it('retains closed months after daily files disappear, without archiving the current month', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'border-archive-'));
    const history = path.join(root, 'history'); const archive = path.join(root, 'archive');
    fs.mkdirSync(history);
    try {
      const old = path.join(history, `${previousDay}.json`);
      fs.writeFileSync(old, JSON.stringify(row()));
      fs.writeFileSync(path.join(history, `${now}.json`), JSON.stringify(row(now)));
      expect(writeBorderWaitArchive(history, archive, now)).toBe(1);
      expect(writeBorderWaitArchive(history, archive, now)).toBe(0);
      fs.unlinkSync(old);
      writeBorderWaitArchive(history, archive, now);
      expect(readBorderWaitArchive(archive)).toEqual([compactBorderWaitArchiveDay(row())]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves archive rendering and lets the rolling snapshot replace overlapping dates once', () => {
    const day = row(); const compact = compactBorderWaitArchiveDay(day);
    const rawPages = generateBorderWaitArchives({ history: [day], today });
    expect(generateBorderWaitArchives({ history: [compact], today })).toEqual(rawPages);
    expect(generateBorderWaitArchives({ history: [compact, row(previousDay, 9)], today })).toEqual(generateBorderWaitArchives({ history: [row(previousDay, 9)], today }));
    expect(Object.keys(rawPages)).toHaveLength(20);
  });
});
