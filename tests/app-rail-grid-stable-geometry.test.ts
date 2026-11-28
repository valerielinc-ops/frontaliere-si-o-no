import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const app = readFileSync(resolve(root, 'App.tsx'), 'utf8');

describe('App rail grid geometry is constant after first paint (CLS #20409/#20411)', () => {
  it('never assigns gridTemplateColumns inline (effect or JSX style)', () => {
    expect(app).not.toMatch(/gridTemplateColumns/);
    expect(app).not.toMatch(/style\.setProperty\(\s*['"]grid-template-columns/);
  });

  it('does not keep a railsCollapsed state fed by ad verdicts', () => {
    expect(app).not.toMatch(/railsCollapsed|setRailsCollapsed/);
  });

  it('keeps the app-shell-col min-height class independent of the static handoff', () => {
    const m = app.match(/className=\{`app-shell-col[^`]*`\}/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/staticOverlay|staticSnapshotOwnsBody/);
    expect(m![0]).toContain('min-h-screen');
  });

  it('SPA rail grid columns come from a class, not JS', () => {
    expect(app).toContain('xlw:grid-cols-[160px_minmax(0,1fr)_160px]');
  });
});
