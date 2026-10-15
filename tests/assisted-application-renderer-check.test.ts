import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { getRemoteConfigValue } = await import('../functions/src/remoteConfigSecrets.js');
const { readRendererCheck, rendererCheckDue, runRendererCheck } = await import('../functions/src/assistedApplicationRendererCheck.js');
const { compileTemplate, renderLetterPdf } = await import('../functions/src/assistedApplicationPdfRenderer.js');
const { extractPdfText } = await import('../functions/src/assistedApplicationAiDocuments.js');
const { pdfRendererLine, LEGACY_RENDERER_NOTE } = await import('../services/assistedApplicationPdfRendererStatus');

const DOC = 'meta/assistedApplicationPdfRenderer';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.now();
const SERVICE = 'sweepassistedapplicationfollowups';
// A real Typst error: the addon throws an Error with an empty message, its diagnostic in `code`.
const broken = (template: string) => compileTemplate(template, {});

describe('self-check of the PDF renderer in the Cloud Functions', () => {
  it('renders an invented letter and CV with Typst and reads the name back with č and ć', async () => {
    const store = createMemoryFirestore();
    const rendered: Buffer[] = [];
    const compile = async (template: string, data: object) => {
      const pdf = await compileTemplate(template, data);
      rendered.push(pdf);
      return pdf;
    };
    const result = await runRendererCheck({ db: store.db, nowMs: NOW, compile, env: { K_SERVICE: SERVICE, K_REVISION: `${SERVICE}-00042-abc` } });
    expect(result).toMatchObject({
      status: 'ok', switch: 'typst', error: null, node: process.version, service: SERVICE, revision: `${SERVICE}-00042-abc`, checkedAt: NOW, failingSince: null,
    });
    expect(result.rssMb).toBeGreaterThan(0);
    // The two documents, read back here too: the letters the standard-font writer prints as "c".
    expect(rendered).toHaveLength(2);
    for (const pdf of rendered) expect(await extractPdfText(pdf)).toContain('Luka Kovačević');
    // What is stored is what is returned, and nothing else.
    expect(store.read(DOC)).toEqual(result);
    expect(Object.keys(result).sort()).toEqual(['checkedAt', 'error', 'failingSince', 'node', 'revision', 'rssMb', 'service', 'status', 'switch']);
  }, 60_000);

  it('does not take the standard-font writer for Typst: the name loses its č and ć', async () => {
    const compile = async (_template: string, data: any) => (await renderLetterPdf(data, { mode: 'legacy' })).pdf;
    const result = await runRendererCheck({ db: createMemoryFirestore().db, nowMs: NOW, compile, env: {} });
    expect(result).toMatchObject({ status: 'failed', error: 'assisted-letter.typ: the name with č and ć is not in the text of the PDF' });
  }, 60_000);

  it('fails when the text is not in the bundled Source Sans 3, as when the font directory is missing', async () => {
    const { NodeCompiler } = await import('@myriaddreamin/typst-ts-node-compiler');
    const bare = NodeCompiler.create();
    // Without its font directory Typst compiles all the same in its own serif, with a warning only.
    const compile = async (_template: string, data: object) => Buffer.from(bare.pdf({
      mainFileContent: '#let d = json(bytes(sys.inputs.data))\n#set text(font: "Libertinus Serif")\n#d.signature',
      inputs: { data: JSON.stringify(data) },
    }));
    const result = await runRendererCheck({ db: createMemoryFirestore().db, nowMs: NOW, compile, env: {} });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^assisted-letter\.typ: the text is not in the embedded Source Sans 3 \(.*LibertinusSerif/);
  }, 60_000);

  it('keeps the time of the first failure while it keeps failing, and clears it once Typst works again', async () => {
    const store = createMemoryFirestore();
    const env = { K_REVISION: 'rev-1' };
    const first = await runRendererCheck({ db: store.db, nowMs: NOW, compile: broken, env });
    expect(first).toMatchObject({ status: 'failed', checkedAt: NOW, failingSince: NOW });
    expect(first.error).toMatch(/^assisted-letter\.typ: .*does not contain key/);
    const second = await runRendererCheck({ db: store.db, nowMs: NOW + DAY, compile: broken, env });
    expect(second).toMatchObject({ status: 'failed', checkedAt: NOW + DAY, failingSince: NOW });
    const healed = await runRendererCheck({ db: store.db, nowMs: NOW + 2 * DAY, compile: compileTemplate, env });
    expect(healed).toMatchObject({ status: 'ok', error: null, checkedAt: NOW + 2 * DAY, failingSince: null });
    expect(store.read(DOC)).toMatchObject({ status: 'ok', failingSince: null });
  }, 60_000);

  it('keeps only the first line of the error, capped', async () => {
    const compile = async () => { throw new Error(`${'x'.repeat(500)}\nsecond line`); };
    const { error } = await runRendererCheck({ db: createMemoryFirestore().db, nowMs: NOW, compile, env: {} });
    expect(error.startsWith('assisted-letter.typ: xxx')).toBe(true);
    expect(error.length).toBe(200);
    expect(error).not.toContain('second line');
  });

  it('records the switch apart from the status: on legacy Typst is still checked', async () => {
    vi.mocked(getRemoteConfigValue).mockResolvedValueOnce('legacy');
    const onLegacy = await runRendererCheck({ db: createMemoryFirestore().db, nowMs: NOW, compile: compileTemplate, env: { K_SERVICE: SERVICE } });
    expect(onLegacy).toMatchObject({ status: 'ok', switch: 'legacy' });
    const failing = await runRendererCheck({ db: createMemoryFirestore().db, nowMs: NOW, compile: broken, env: { K_SERVICE: SERVICE } });
    expect(failing).toMatchObject({ status: 'failed', switch: 'typst' });
  }, 60_000);

  it('runs once a day, and at once on another revision: a deploy is checked by the next run', async () => {
    const stored = { status: 'ok', switch: 'typst', error: null, checkedAt: NOW, revision: 'rev-1', failingSince: null };
    expect(rendererCheckDue(null, { nowMs: NOW, revision: 'rev-1', mode: 'typst' })).toBe(true);
    expect(rendererCheckDue(stored, { nowMs: NOW + 30 * MINUTE, revision: 'rev-1', mode: 'typst' })).toBe(false);
    expect(rendererCheckDue(stored, { nowMs: NOW + DAY - 1, revision: 'rev-1', mode: 'typst' })).toBe(false);
    expect(rendererCheckDue(stored, { nowMs: NOW + DAY, revision: 'rev-1', mode: 'typst' })).toBe(true);
    expect(rendererCheckDue(stored, { nowMs: NOW + 30 * MINUTE, revision: 'rev-2', mode: 'typst' })).toBe(true);
    expect(rendererCheckDue({ ...stored, checkedAt: undefined }, { nowMs: NOW, revision: 'rev-1', mode: 'typst' })).toBe(true);
    // Not due: nothing is rendered and the stored result stays.
    const store = createMemoryFirestore({ [DOC]: stored });
    const compile = vi.fn();
    expect(await runRendererCheck({ db: store.db, nowMs: NOW + HOUR, compile, env: { K_REVISION: 'rev-1' } })).toBeNull();
    expect(compile).not.toHaveBeenCalled();
    expect(store.read(DOC)).toEqual(stored);
    const deployed = await runRendererCheck({ db: store.db, nowMs: NOW + HOUR, compile: compileTemplate, env: { K_REVISION: 'rev-2' } });
    expect(deployed).toMatchObject({ status: 'ok', revision: 'rev-2', checkedAt: NOW + HOUR });
  }, 60_000);

  // The switch is read at every run: the owner's line follows a flip at the next run, not a day later.
  it('runs at the next run when the switch moved, both ways, and records it', async () => {
    const stored = { status: 'ok', switch: 'typst', error: null, checkedAt: NOW, revision: 'rev-1', failingSince: null };
    expect(rendererCheckDue(stored, { nowMs: NOW + 30 * MINUTE, revision: 'rev-1', mode: 'legacy' })).toBe(true);
    expect(rendererCheckDue({ ...stored, switch: 'legacy' }, { nowMs: NOW + 30 * MINUTE, revision: 'rev-1', mode: 'typst' })).toBe(true);
    const store = createMemoryFirestore({ [DOC]: stored });
    const env = (mode: string) => ({ K_REVISION: 'rev-1', ASSISTED_APPLICATION_PDF_RENDERER: mode });
    const toLegacy = await runRendererCheck({ db: store.db, nowMs: NOW + 30 * MINUTE, compile: compileTemplate, env: env('legacy') });
    expect(toLegacy).toMatchObject({ status: 'ok', switch: 'legacy', checkedAt: NOW + 30 * MINUTE });
    expect(store.read(DOC)).toMatchObject({ switch: 'legacy', checkedAt: NOW + 30 * MINUTE });
    // The same switch at the next run: not due, nothing is rendered.
    const compile = vi.fn();
    expect(await runRendererCheck({ db: store.db, nowMs: NOW + HOUR, compile, env: env('legacy') })).toBeNull();
    expect(compile).not.toHaveBeenCalled();
    const back = await runRendererCheck({ db: store.db, nowMs: NOW + 90 * MINUTE, compile: compileTemplate, env: env('typst') });
    expect(back).toMatchObject({ status: 'ok', switch: 'typst', checkedAt: NOW + 90 * MINUTE });
  }, 60_000);

  it('checks a failed result again at every run: a failure that went away is red for one run, not a day', async () => {
    const stored = { status: 'failed', switch: 'typst', error: 'assisted-letter.typ: x', checkedAt: NOW, revision: 'rev-1', failingSince: NOW - HOUR };
    expect(rendererCheckDue(stored, { nowMs: NOW + 30 * MINUTE, revision: 'rev-1', mode: 'typst' })).toBe(true);
    const store = createMemoryFirestore({ [DOC]: stored });
    const env = { K_REVISION: 'rev-1' };
    // Still failing: checked again, and the time of the first failure stays.
    const still = await runRendererCheck({ db: store.db, nowMs: NOW + 30 * MINUTE, compile: broken, env });
    expect(still).toMatchObject({ status: 'failed', checkedAt: NOW + 30 * MINUTE, failingSince: NOW - HOUR });
    const healed = await runRendererCheck({ db: store.db, nowMs: NOW + HOUR, compile: compileTemplate, env });
    expect(healed).toMatchObject({ status: 'ok', checkedAt: NOW + HOUR, failingSince: null });
    // Ok again: once a day.
    const compile = vi.fn();
    expect(await runRendererCheck({ db: store.db, nowMs: NOW + 90 * MINUTE, compile, env })).toBeNull();
    expect(compile).not.toHaveBeenCalled();
  }, 60_000);

  it('hands the owner queue the stored result only, null before the first check', async () => {
    const store = createMemoryFirestore();
    expect(await readRendererCheck(store.db)).toBeNull();
    await store.db.collection('meta').doc('assistedApplicationPdfRenderer').set({ status: 'ok', switch: 'typst', checkedAt: NOW, other: 'not for the queue' });
    expect(await readRendererCheck(store.db)).toEqual({
      status: 'ok', switch: 'typst', error: null, node: null, service: null, revision: null, rssMb: null, checkedAt: NOW, failingSince: null,
    });
  });
});

describe('Typst cache in a long-lived process', () => {
  it('is evicted after each compile, and an eviction that fails never costs a document', async () => {
    const { NodeCompiler } = await import('@myriaddreamin/typst-ts-node-compiler');
    const evict = vi.spyOn(NodeCompiler.prototype, 'evictCache').mockImplementation(() => { throw new Error('evict failed'); });
    try {
      const letter = await renderLetterPdf({ senderLines: ['Luka Kovačević'], signature: 'Luka Kovačević' });
      expect(letter.renderer).toBe('typst');
      expect(evict).toHaveBeenCalledTimes(1);
      // After a compile that failed too.
      await expect(broken('assisted-letter.typ')).rejects.toBeTruthy();
      expect(evict).toHaveBeenCalledTimes(2);
    } finally {
      evict.mockRestore();
    }
  }, 60_000);
});

describe('functions/index.js: room for Typst and the host of the check', () => {
  const index = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
  const exported = (name: string) => {
    const start = index.indexOf(`export const ${name} = `);
    expect(start, name).toBeGreaterThan(-1);
    return index.slice(start, index.indexOf('\nexport const ', start + 1));
  };
  const options = (name: string) => {
    const source = exported(name);
    const open = source.indexOf('{ region:');
    return source.slice(open, source.indexOf('\n', open));
  };
  // The statements of an exported function's handler, read off the syntax tree: comments and layout do not count.
  const handlerStatements = (name: string): readonly ts.Statement[] => {
    const source = ts.createSourceFile('index.js', index, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const call = declaration.initializer;
        if (declaration.name.getText() !== name || !call || !ts.isCallExpression(call)) continue;
        const handler = call.arguments[1];
        if (handler && ts.isArrowFunction(handler) && ts.isBlock(handler.body)) return handler.body.statements;
      }
    }
    return [];
  };
  // Whether a node holds a statement of this kind, functions nested in it left out (their own return is theirs).
  const holds = (node: ts.Node, is: (child: ts.Node) => boolean): boolean => {
    let found = false;
    const visit = (child: ts.Node) => {
      if (found || ts.isFunctionLike(child)) return;
      if (is(child)) found = true;
      else child.forEachChild(visit);
    };
    node.forEachChild(visit);
    return found;
  };
  // The names of the functions called anywhere inside a node.
  const callsIn = (node: ts.Node): string[] => {
    const names: string[] = [];
    const visit = (child: ts.Node) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) names.push(child.expression.text);
      child.forEachChild(visit);
    };
    visit(node);
    return names;
  };

  // The owner's edit of the letter compiles it with Typst: an out-of-memory kill cannot fall back.
  it('gives the owner endpoint the memory and the time of the candidate review endpoint', () => {
    expect(options('manageAssistedApplicationAdmin')).toMatch(/memory: '512MiB'/);
    expect(options('manageAssistedApplicationAdmin')).toMatch(/timeoutSeconds: 60\b/);
    const room = (name: string) => [options(name).match(/memory: '([^']+)'/)?.[1], options(name).match(/timeoutSeconds: (\d+)/)?.[1]];
    expect(room('manageAssistedApplicationAdmin')).toEqual(room('assistedApplicationReview'));
  });

  it('runs the check in the follow-up sweep, after it and on its own: off flag or failing check alike', () => {
    expect(options('sweepAssistedApplicationFollowups')).toMatch(/memory: '512MiB'/);
    expect(options('sweepAssistedApplicationFollowups')).toMatch(/schedule: 'every 30 minutes'/);
    const statements = handlerStatements('sweepAssistedApplicationFollowups');
    const sweepAt = statements.findIndex((statement) => callsIn(statement).includes('runFollowupSweep'));
    const checkAt = statements.findIndex((statement) => callsIn(statement).includes('runRendererCheck'));
    expect(sweepAt).toBeGreaterThan(-1);
    // A statement of the handler of its own, after the sweep's: never inside the sweep's try or its catch.
    expect(checkAt).toBeGreaterThan(sweepAt);
    // Each in a try with a catch: a sweep that throws does not skip the check, a check that throws does not fail the run.
    for (const statement of [statements[sweepAt], statements[checkAt]]) {
      expect(ts.isTryStatement(statement) && Boolean(statement.catchClause)).toBe(true);
    }
    expect(callsIn((statements[checkAt] as ts.TryStatement).tryBlock)).toContain('runRendererCheck');
    // Nothing before the check leaves the handler early (an off automation flag must not skip it)…
    expect(statements.slice(0, checkAt).some((statement) => ts.isReturnStatement(statement) || holds(statement, ts.isReturnStatement))).toBe(false);
    // …and the check's catch does not throw again.
    expect(holds((statements[checkAt] as ts.TryStatement).catchClause!.block, ts.isThrowStatement)).toBe(false);
  });
});

describe('what the owner queue says about the renderer', () => {
  const when = (ms: number) => `T${Math.round((ms - NOW) / HOUR)}h`;
  const check = (fields: Record<string, unknown> = {}) => ({
    status: 'ok' as const, switch: 'typst' as const, error: null, node: 'v22.0.0', service: SERVICE, revision: 'rev-1', rssMb: 180, checkedAt: NOW - HOUR, failingSince: null, ...fields,
  });

  it('says whether Typst works, since when it does not, and when the switch overrides it', () => {
    expect(pdfRendererLine(check(), NOW, when)).toEqual({ tone: 'ok', text: 'PDF: Typst funziona (verificato T-1h)' });
    expect(pdfRendererLine(check({ status: 'failed', error: 'x', failingSince: NOW - 5 * HOUR }), NOW, when)).toEqual({
      tone: 'failed', text: 'PDF: Typst NON funziona dal T-5h — i documenti escono con il generatore di riserva (senza č, ć…)',
    });
    const legacy = pdfRendererLine(check({ switch: 'legacy' }), NOW, when);
    expect(legacy.tone).toBe('legacy');
    expect(legacy.text.startsWith('PDF: interruttore su legacy')).toBe(true);
    expect(LEGACY_RENDERER_NOTE).toBe('PDF dal generatore di riserva (senza č, ć…)');
  });

  it('never reads a missing or stale result as ok', () => {
    expect(pdfRendererLine(null, NOW, when)).toEqual({ tone: 'unknown', text: 'PDF: non ancora verificato' });
    expect(pdfRendererLine(check({ checkedAt: null }), NOW, when).tone).toBe('unknown');
    expect(pdfRendererLine(check({ checkedAt: NOW - 47 * HOUR }), NOW, when).tone).toBe('ok');
    expect(pdfRendererLine(check({ checkedAt: NOW - 48 * HOUR }), NOW, when)).toEqual({ tone: 'unknown', text: 'PDF: non ancora verificato (ultima verifica T-48h)' });
    expect(pdfRendererLine(check({ checkedAt: NOW - 72 * HOUR, status: 'failed', failingSince: NOW - 72 * HOUR }), NOW, when).tone).toBe('unknown');
  });
});
