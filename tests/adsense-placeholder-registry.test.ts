/**
 * Regression pin for issue #4677 — field p75 CLS on /cerca-lavoro-ticino/.
 *
 * `AD_SLOTS[…].placeholderMinHeight` is the declared source of truth for how
 * much layout space an ad unit reserves before it fills. Only the build-time
 * emitter read it; the runtime SPA component resolved the reserve from a
 * format-only heuristic and 42 of 49 `<AdSenseBanner>` call sites passed no
 * `minHeight` override. The registry raise 280 → 336 for the #4302 CLS
 * campaign was therefore inert on the SPA: `/cerca-lavoro-ticino/` kept
 * reserving 280px per in-feed unit in production (verified live), and the job
 * list interleaves up to JOBLIST_AD_MAX_PER_LIST of them.
 *
 * These tests fail on the pre-fix tree (the in-feed slots resolved to 280) and
 * lock the registry↔runtime contract so the two paths cannot drift again.
 *
 * NB: never assert "reserve less" here. The only sanctioned CLS lever on an ad
 * whose height Google picks at fill time is reserving space (AGENTS.md §7) —
 * lowering a reserve to make a number look better is the failure mode this
 * file exists to catch.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AD_SLOTS,
  MULTIPLEX_DESKTOP_MIN_HEIGHT,
  MULTIPLEX_DESKTOP_MIN_WIDTH,
  resolveSlotPlaceholderMinHeight,
} from '../services/adsenseSlots';
import { resolvePlaceholderMinHeight } from '../components/shared/AdSenseBanner';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type SlotEntry = {
  slot: string;
  format: string;
  layout?: string;
  placeholderMinHeight?: number;
};

const entries = Object.entries(AD_SLOTS) as [string, SlotEntry][];

describe('AD_SLOTS placeholder reserve — registry is the single source of truth', () => {
  it('every registry slot resolves to its own declared reserve (mobile/SSR)', () => {
    for (const [name, cfg] of entries) {
      if (typeof cfg.placeholderMinHeight !== 'number') continue;
      expect(
        resolveSlotPlaceholderMinHeight(cfg.slot, cfg.format, cfg.layout),
        `${name} must resolve to its registry placeholderMinHeight`,
      ).toBe(cfg.placeholderMinHeight);
    }
  });

  it('the (slot, format, layout) triple is collision-free', () => {
    // Slot ids are deliberately REUSED across placements (see the "Slot id
    // REUSES …" notes in the registry): 3205029282 is shared by
    // JOBLIST_INFEED_MOBILE (336) and JOBDETAIL_TOP_BANNER (100). Resolving by
    // slot id alone would silently pick one of the two reserves for both.
    const byTriple = new Map<string, Set<number>>();
    for (const [, cfg] of entries) {
      if (typeof cfg.placeholderMinHeight !== 'number') continue;
      const key = `${cfg.slot}|${cfg.format}|${cfg.layout ?? ''}`;
      if (!byTriple.has(key)) byTriple.set(key, new Set());
      byTriple.get(key)!.add(cfg.placeholderMinHeight);
    }
    const collisions = [...byTriple].filter(([, v]) => v.size > 1).map(([k]) => k);
    expect(collisions).toEqual([]);
  });

  it('slot id alone is NOT a safe key (guards the resolver against regressing to it)', () => {
    const bySlot = new Map<string, Set<number>>();
    for (const [, cfg] of entries) {
      if (typeof cfg.placeholderMinHeight !== 'number') continue;
      if (!bySlot.has(cfg.slot)) bySlot.set(cfg.slot, new Set());
      bySlot.get(cfg.slot)!.add(cfg.placeholderMinHeight);
    }
    const ambiguous = [...bySlot].filter(([, v]) => v.size > 1);
    expect(ambiguous.length).toBeGreaterThan(0);
  });

  it('unknown slots fall through to the format heuristic', () => {
    expect(resolveSlotPlaceholderMinHeight('0000000000', 'auto', undefined)).toBeUndefined();
    expect(resolvePlaceholderMinHeight('0000000000', 'auto', undefined, 390)).toBe(280);
    expect(resolvePlaceholderMinHeight('0000000000', 'fluid', undefined, 390)).toBe(220);
    expect(resolvePlaceholderMinHeight('0000000000', 'auto', 'in-article', 390)).toBe(220);
  });
});

describe('#4677 — job-list in-feed units reserve the registry height, not the old 280', () => {
  for (const key of ['JOBLIST_INFEED_MOBILE', 'JOBLIST_INFEED_DESKTOP'] as const) {
    it(`${key} resolves to ${AD_SLOTS[key].placeholderMinHeight}px at runtime`, () => {
      const cfg = AD_SLOTS[key] as SlotEntry;
      const resolved = resolvePlaceholderMinHeight(cfg.slot, cfg.format, cfg.layout, 390);
      expect(resolved).toBe(cfg.placeholderMinHeight);
      // The pre-fix value. Asserted explicitly so a future "simplification"
      // back to the format heuristic turns this red instead of silently
      // re-introducing the under-reserve.
      expect(resolved).toBeGreaterThan(280);
    });
  }

  it('the in-feed wrappers derive their reserve from the registry, not a literal', () => {
    for (const rel of ['components/community/JobBoard.tsx', 'components/community/JobExpiredView.tsx']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(src, `${rel} must not hard-code an in-feed ad reserve`).not.toMatch(
        /className="(?:my-3 )?min-h-\[280px\]"/,
      );
      expect(src).toContain('placeholderMinHeight');
    }
  });

  it('the SSG blog ad placeholders reserve the registry height too', () => {
    // Sibling of the same class (AGENTS.md #6): staticPagesPlugin pinned a flat
    // 180px `.s-1zvlaE` placeholder while its comment claimed it "matched
    // AdSenseBanner's placeholderMinHeight values" — it matched neither the
    // in-article inline unit nor the end-of-article multiplex.
    const src = fs.readFileSync(path.join(ROOT, 'build-plugins', 'staticPagesPlugin.ts'), 'utf-8');
    expect(src, 'the flat 180px blog ad placeholder must be gone').not.toMatch(/class="s-1zvlaE"/);
    // Reached through the SAME resolver the runtime uses — reading the registry
    // field directly here would re-create two independently-typed read sites.
    expect(src).toContain('resolveSlotPlaceholderMinHeight');
    expect(src).toContain('AD_SLOTS.ARTICLE_INLINE_MOBILE');
    expect(src).toContain('AD_SLOTS.ARTICLE_END_MULTIPLEX');
  });
});

describe('multiplex desktop uplift survives the registry switch', () => {
  it('autorelaxed slots keep the wide-viewport floor', () => {
    const cfg = AD_SLOTS.ARTICLE_END_MULTIPLEX as SlotEntry;
    expect(cfg.format).toBe('autorelaxed');
    expect(resolvePlaceholderMinHeight(cfg.slot, cfg.format, cfg.layout, MULTIPLEX_DESKTOP_MIN_WIDTH))
      .toBe(MULTIPLEX_DESKTOP_MIN_HEIGHT);
    expect(resolvePlaceholderMinHeight(cfg.slot, cfg.format, cfg.layout, 390))
      .toBe(cfg.placeholderMinHeight);
  });

  it('a registry reserve TALLER than the desktop floor is never lowered to it', () => {
    const cfg = AD_SLOTS.HOMEPAGE_MID_DISPLAY as SlotEntry;
    expect(cfg.placeholderMinHeight).toBeGreaterThan(MULTIPLEX_DESKTOP_MIN_HEIGHT);
    expect(resolvePlaceholderMinHeight(cfg.slot, cfg.format, cfg.layout, 1440))
      .toBe(cfg.placeholderMinHeight);
  });

  it('a non-multiplex slot is never lifted by the multiplex floor', () => {
    // JOBDETAIL_TOP_BANNER renders a ~90px horizontal banner. Over-reserving it
    // to a multiplex height would carve dead space above the fold on every job
    // detail page.
    const cfg = AD_SLOTS.JOBDETAIL_TOP_BANNER as SlotEntry;
    expect(resolvePlaceholderMinHeight(cfg.slot, cfg.format, cfg.layout, 1440))
      .toBe(cfg.placeholderMinHeight);
  });
});

describe('every call site actually reaches the registry', () => {
  // Reviewer finding on PR #5106. The resolver is keyed on the
  // (slot, format, layout) TRIPLE, so a call site that passes `adSlot` and
  // `adFormat` but omits `adLayout` for a slot that declares one builds the key
  // `slot|fluid|`, misses the lookup, and silently falls through to the format
  // heuristic. Today `fluid` and `in-article` happen to agree at 220, so the
  // miss is invisible — until someone raises ARTICLE_INLINE_MOBILE the way
  // JOBLIST_INFEED_* was raised 280 → 336 for #4302, at which point those call
  // sites keep the stale value. That is #4677 all over again, so it is pinned
  // structurally (does the prop reach the resolver?) rather than by grepping
  // for one literal spelling.
  it('a slot that declares a layout is never rendered without adLayout', () => {
    const offenders: string[] = [];
    const layoutSlots = new Set(
      entries.filter(([, cfg]) => typeof cfg.layout === 'string').map(([name]) => name),
    );
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.tsx')) continue;
        const src = fs.readFileSync(p, 'utf-8');
        for (const m of src.matchAll(/<AdSenseBanner\b([\s\S]*?)\/>/g)) {
          const blob = m[1];
          const slot = /adSlot=\{AD_SLOTS\.([A-Z_0-9]+)\.slot\}/.exec(blob);
          if (!slot || !layoutSlots.has(slot[1])) continue;
          if (!/adLayout=/.test(blob)) {
            offenders.push(`${path.relative(ROOT, p)} → ${slot[1]}`);
          }
        }
      }
    };
    walk(path.join(ROOT, 'components'));
    expect(offenders).toEqual([]);
  });

  it('resolution misses when the declared layout is dropped', () => {
    // Pins the mechanism the test above guards, so the guard cannot be
    // "simplified" away on the belief that the triple key is forgiving.
    const cfg = AD_SLOTS.ARTICLE_INLINE_MOBILE as SlotEntry;
    expect(cfg.layout).toBe('in-article');
    expect(resolveSlotPlaceholderMinHeight(cfg.slot, cfg.format, cfg.layout)).toBe(cfg.placeholderMinHeight);
    expect(resolveSlotPlaceholderMinHeight(cfg.slot, cfg.format, undefined)).toBeUndefined();
  });
});

describe('no call site re-duplicates a registry reserve', () => {
  it('`minHeight={AD_SLOTS.X.placeholderMinHeight}` is gone from every component', () => {
    // A literal copy of a registry constant at the call site is exactly how the
    // 280/336 drift happened (AGENTS.md #6: a constant duplicated in ≥2 files
    // must live in ONE shared module). The component resolves it now.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tsx')) {
          if (/minHeight=\{AD_SLOTS\.[A-Z_0-9]+\.placeholderMinHeight\}/.test(fs.readFileSync(p, 'utf-8'))) {
            offenders.push(path.relative(ROOT, p));
          }
        }
      }
    };
    walk(path.join(ROOT, 'components'));
    expect(offenders).toEqual([]);
  });
});
