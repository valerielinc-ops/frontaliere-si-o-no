import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMopupRequest, orderMopupRequestsTitleFirst } from '../scripts/local-mt-mopup.mjs';

/**
 * The Argos mop-up batch puts every title before every description.
 *
 * The worker (scripts/local-mt-translate.py) translates units in the order it
 * reads them and a timeout kill keeps only the requests already complete. With
 * the batch built job by job, a title (one unit) and its description (~9 units
 * on average) alternated, so on a saturated run the titles of most selected
 * jobs never started: translate-pending 36779310211 (2026-10-01) killed the
 * worker at 150 minutes with 4,749 of 16,990 requests done.
 *
 * The second block runs the REAL worker with a fake Argos engine (the package
 * is not installed here, as in tests/python/local_mt_translate_sentinel_test.py)
 * to pin the premise both ways: request order is translation order, so the
 * title-first batch reaches every title before any description unit, and the
 * job-by-job batch does not.
 */

type Field = 'title' | 'description';
interface Slot { job: string; locale: string; field: Field; text: string }

const SLOTS: Slot[] = [
  { job: 'a', locale: 'it', field: 'title', text: 'Lagermitarbeiter 100%' },
  { job: 'a', locale: 'it', field: 'description', text: 'Ihre Aufgaben\n- Kommissionieren\n- Verpacken\n- Inventur' },
  { job: 'b', locale: 'it', field: 'title', text: 'Pflegefachmann HF' },
  { job: 'b', locale: 'it', field: 'description', text: 'Wir bieten\n- Weiterbildung\n- Teamarbeit' },
  { job: 'c', locale: 'en', field: 'description', text: 'Ihr Profil\n- Erfahrung\n- Deutsch' },
  { job: 'c', locale: 'en', field: 'title', text: 'Elektroinstallateur EFZ' },
];

function buildBatch(slots: Slot[]) {
  const fields = new Map<string, Field>();
  const requests = slots.map((slot, index) => {
    const id = `r${index}`;
    fields.set(id, slot.field);
    return buildMopupRequest({ id, text: slot.text, from: 'de', to: slot.locale, field: slot.field }).request;
  });
  return { requests, fieldOf: (r: { id: string }) => fields.get(r.id) };
}

describe('orderMopupRequestsTitleFirst()', () => {
  it('puts every title before every description and keeps the traffic order inside each group', () => {
    const { requests, fieldOf } = buildBatch(SLOTS);
    const ordered = orderMopupRequestsTitleFirst(requests, fieldOf);

    expect(ordered.map((r: { id: string }) => r.id)).toEqual(['r0', 'r2', 'r5', 'r1', 'r3', 'r4']);
  });

  it('neither drops nor duplicates a request and returns the same objects', () => {
    const { requests, fieldOf } = buildBatch(SLOTS);
    const ordered = orderMopupRequestsTitleFirst(requests, fieldOf);

    expect(ordered).toHaveLength(requests.length);
    expect(new Set(ordered)).toEqual(new Set(requests));
  });

  it('keeps a request with an unknown field behind the titles instead of dropping it', () => {
    const requests = [{ id: 'x' }, { id: 't' }];
    const ordered = orderMopupRequestsTitleFirst(requests, (r: { id: string }) => (r.id === 't' ? 'title' : undefined));

    expect(ordered.map((r: { id: string }) => r.id)).toEqual(['t', 'x']);
  });

  it('leaves an empty batch empty', () => {
    expect(orderMopupRequestsTitleFirst([], () => 'title')).toEqual([]);
  });

  it('is the order main() hands to the worker', () => {
    // main() reads fixed repo paths, so it cannot run on fixtures here; the
    // same source-level check the CLI-flag guard in
    // tests/translation-protected-tokens.test.ts uses.
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'local-mt-mopup.mjs'), 'utf8');
    expect(source).toMatch(/const orderedRequests = orderMopupRequestsTitleFirst\(requests, \(r\) => targets\.get\(r\.id\)\?\.field\);/);
    expect(source).toMatch(/const jsonl = orderedRequests\.map\(\(r\) => JSON\.stringify\(r\)\)/);
  });
});

/**
 * Runs translate_stream() of the real worker with LOCAL_MT_WORKERS=1 and a fake
 * `argostranslate.translate` that records every text it is asked for. Returns
 * the recorded texts, warm-up calls ("test") excluded.
 */
function argosCallOrder(requests: Array<{ id: string }>): string[] {
  const worker = path.join(__dirname, '..', 'scripts', 'local-mt-translate.py');
  const program = `
import importlib.util, io, json, sys, types
seen = []
def fake(text, frm, to):
    seen.append(text)
    return "[" + to + "] " + text
mod_t = types.ModuleType("argostranslate.translate")
mod_t.translate = fake
sys.modules["argostranslate"] = types.ModuleType("argostranslate")
sys.modules["argostranslate.translate"] = mod_t
spec = importlib.util.spec_from_file_location("local_mt_translate", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
real_stdout = sys.stdout
sys.stdout = io.StringIO()
mod.translate_stream()
sys.stdout = real_stdout
print(json.dumps([s for s in seen if s != "test"]))
`;
  const proc = spawnSync('python3', ['-c', program, worker], {
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf-8',
    env: { ...process.env, LOCAL_MT_WORKERS: '1' },
  });
  if (proc.error) throw new Error(`failed to spawn python3: ${proc.error.message}`);
  expect(proc.status, `stderr:\n${proc.stderr}`).toBe(0);
  return JSON.parse(proc.stdout.trim().split('\n').pop() || '[]');
}

describe('local-mt-translate.py translates in request order', () => {
  const titleTexts = SLOTS.filter((s) => s.field === 'title').map((s) => s.text);
  const isTitleUnit = (text: string) => titleTexts.some((t) => text.startsWith(t.split(' ')[0]));

  it('reaches every title before any description unit when the batch is title-first', () => {
    const { requests, fieldOf } = buildBatch(SLOTS);
    const calls = argosCallOrder(orderMopupRequestsTitleFirst(requests, fieldOf));

    expect(calls.length).toBeGreaterThan(titleTexts.length);
    const firstDescription = calls.findIndex((text) => !isTitleUnit(text));
    expect(calls.slice(0, firstDescription).filter(isTitleUnit)).toHaveLength(titleTexts.length);
    expect(calls.slice(firstDescription).some(isTitleUnit)).toBe(false);
  });

  it('interleaves titles behind description units when the batch is built job by job', () => {
    const { requests } = buildBatch(SLOTS);
    const calls = argosCallOrder(requests);

    const lastTitle = calls.map(isTitleUnit).lastIndexOf(true);
    const firstDescription = calls.findIndex((text) => !isTitleUnit(text));
    expect(firstDescription).toBeLessThan(lastTitle);
  });
});
