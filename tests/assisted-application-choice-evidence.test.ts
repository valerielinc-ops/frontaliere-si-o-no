import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { applyActions } from '../scripts/assisted-application/lib/portal/fill.mjs';

const sensitive = 'never-export-this-native-identifier';
const markup = `<input id="${sensitive}" name="private-control-name" value="private-value" type="checkbox" data-aa-id="f22" style="display:none">
  <label for="${sensitive}">Private label text <a href="#private-url">policy</a></label>`;
const openDoms: JSDOM[] = [];
afterEach(() => { for (const dom of openDoms) dom.window.close(); openDoms.length = 0; });

type Mode = 'native' | 'uncommitted' | 'label' | 'linked-label' | 'label-timeout' | 'replace' | 'checker-fails';
function fixture(mode: Mode = 'native', collision = false) {
  const doms = Array.from({ length: collision ? 2 : 1 }, () => new JSDOM(markup, { runScripts: 'outside-only' }));
  for (const dom of doms) (dom.window as any).CSS = { escape: (value: string) => value };
  openDoms.push(...doms);
  const calls: string[] = [];
  const disposed = vi.fn(async () => {});
  const observers: AbortController[] = [];
  const targetFrame = collision ? 1 : 0;
  class Locator {
    constructor(readonly doc: Document, readonly selector: string, readonly frame: number) {}
    node() { const node = this.doc.querySelector(this.selector); if (!node) throw new Error('target missing'); return node as HTMLInputElement; }
    first() { return this; }
    count = async () => this.doc.querySelectorAll(this.selector).length;
    elementHandle = async () => ({ node: this.node(), dispose: disposed });
    browserFn(fn: any) { return this.doc.defaultView!.eval(`(${fn.toString()})`); }
    evaluate = async (fn: any, arg?: any) => this.browserFn(fn)(this.node(), arg?.node || arg);
    evaluateHandle = async (fn: any) => {
      const controller = this.browserFn(fn)(this.node()); observers.push(controller);
      return { evaluate: async (read: any) => read(controller), dispose: async () => {} };
    };
    isChecked = async () => { if (mode === 'checker-fails') throw new Error('checker unavailable'); return this.node().checked; };
    setChecked = vi.fn(async (checked: boolean, options: any) => {
      calls.push(`${this.frame}:${options.force ? 'forced' : 'native'}`);
      if (['label', 'linked-label', 'label-timeout'].includes(mode)) throw new Error('hidden control');
      const node = this.node();
      if (mode === 'native' || mode === 'checker-fails') node.checked = checked;
      if (mode === 'replace') {
        node.checked = checked;
        const replacement = node.cloneNode(true) as HTMLInputElement;
        replacement.checked = false;
        node.replaceWith(replacement);
        replacement.after(replacement.cloneNode(true));
      }
    });
    locator() { return new Locator(this.doc, 'label[data-aa-label="choice"]', this.frame); }
    click = async () => {
      calls.push(`${this.frame}:label`);
      if (mode === 'label-timeout') throw new Error('label blocked');
      (mode === 'linked-label' ? this.node().querySelector('a') as HTMLElement : this.node()).click();
    };
  }
  const controls = doms.map((dom, index) => new Locator(dom.window.document, '[data-aa-id="f22"]', index));
  const frames = doms.map((dom, index) => ({ locator: (selector: string) => new Locator(dom.window.document, selector, index) }));
  const page = { frames: () => frames, mainFrame: () => frames[0] };
  const fields = collision
    ? [{ id: 'f22', kind: 'checkbox', frame: 0 }, { id: 'f22', kind: 'checkbox', frame: 1 }]
    : [{ id: 'f22', kind: 'checkbox', frame: 0 }];
  const run = () => applyActions(page as any, fields, [{ fieldId: 'f22', action: 'check' }], {}, { pause: async () => {} });
  return { doms, controls, calls, disposed, observers, run, targetFrame };
}

describe('private failed-choice evidence', () => {
  it('keeps the valid native path at one action and returns no diagnostics on success', async () => {
    const f = fixture();
    expect(await f.run()).toEqual([{ fieldId: 'f22', ok: true }]);
    expect(f.calls).toEqual(['0:native']);
    expect(f.controls[0].node().checked).toBe(true);
    expect(f.disposed).toHaveBeenCalledOnce();
  });

  it('keeps the existing fallback sequence and successful registration unchanged', async () => {
    const f = fixture('label');
    expect(await f.run()).toEqual([{ fieldId: 'f22', ok: true }]);
    expect(f.calls).toEqual(['0:native', '0:forced', '0:label']);
    expect(f.controls[0].node().checked).toBe(true);
  });

  it('records the actual label click tag when a linked descendant does not register the choice', async () => {
    const f = fixture('linked-label');
    const [result] = await f.run();
    expect(result).toMatchObject({ ok: false, error: 'choice_not_registered', choiceEvidence: {
      method: 'label', labelClickTag: 'a',
      attempts: [{ method: 'native', outcome: 'threw' }, { method: 'forced', outcome: 'threw' }, { method: 'label', outcome: 'returned' }],
      before: { checked: false, tag: 'input', inputType: 'checkbox', hidden: true },
      after: { checked: false }, identity: { sameNode: true },
    } });
    expect(f.calls).toEqual(['0:native', '0:forced', '0:label']);
  });

  it('distinguishes a replaced native node, duplicated DOM ids, and logical ids reused across frames', async () => {
    const f = fixture('replace', true);
    const [result] = await f.run();
    expect(result).toMatchObject({ ok: false, error: 'choice_not_registered', choiceEvidence: {
      method: 'native', attempts: [{ method: 'native', outcome: 'returned' }],
      before: { aaIdCount: 1, nativeIdCount: 1 }, after: { checked: false, aaIdCount: 2, nativeIdCount: 2 },
      identity: { sameNode: false, sameNativeId: true, sameName: true },
      logicalFieldCount: 2, logicalFrameIndices: [0, 1], selectedFrameIndex: 1,
      frameMatches: [{ index: 0, count: 1 }, { index: 1, count: 2 }],
    } });
    // Observe the existing last-wins field mapping; diagnostics never redirect the action.
    expect(f.calls).toEqual(['1:native']);
    expect(f.controls[0].node().checked).toBe(false);
    expect(f.disposed).toHaveBeenCalledOnce();
  });

  it('keeps an unregistered native choice failed without adding retries or copying private DOM data', async () => {
    const f = fixture('uncommitted');
    const [result] = await f.run();
    expect(result).toMatchObject({ ok: false, error: 'choice_not_registered', choiceEvidence: {
      method: 'native', before: { checked: false }, after: { checked: false },
    } });
    expect(f.calls).toEqual(['0:native']);
    const serialized = JSON.stringify(result);
    for (const forbidden of [sensitive, 'private-control-name', 'private-value', 'Private label text', 'private-url']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('removes a label observer even when the pointer action times out before dispatch', async () => {
    const f = fixture('label-timeout');
    const [result] = await f.run();
    expect(result).toMatchObject({ ok: false, error: 'label blocked', choiceEvidence: { method: 'label', labelClickTag: null } });
    expect(f.observers).toHaveLength(1);
    expect(f.observers[0].signal.aborted).toBe(true);
    const label = f.doms[0].window.document.querySelector('label')!;
    label.click();
    expect(label.hasAttribute('data-aa-choice-hit')).toBe(false);
    expect(f.calls).toEqual(['0:native', '0:forced', '0:label']);
  });

  it('distinguishes a checker error from the native checked state without accepting the action', async () => {
    const f = fixture('checker-fails');
    const [result] = await f.run();
    expect(result).toMatchObject({ ok: false, error: 'choice_not_registered', choiceEvidence: {
      requestedChecked: true, registeredChecked: null, before: { checked: false }, after: { checked: true },
    } });
    expect(f.calls).toEqual(['0:native']);
  });

  it('does not change a successful choice when observation APIs are unavailable', async () => {
    let checked = false;
    const locator = {
      setChecked: async () => { checked = true; }, isChecked: async () => checked,
      evaluate: async () => { throw new Error('observation unavailable'); },
      elementHandle: async () => { throw new Error('observation unavailable'); },
    };
    const frame = { locator: () => ({ first: () => locator }) };
    expect(await applyActions({ frames: () => [frame], mainFrame: () => frame } as any,
      [{ id: 'f22', kind: 'checkbox' }], [{ fieldId: 'f22', action: 'check' }], {}, { pause: async () => {} }))
      .toEqual([{ fieldId: 'f22', ok: true }]);
  });
});
