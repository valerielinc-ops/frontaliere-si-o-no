/**
 * Tests for error tracking helpers exported from services/analytics.ts:
 * - extractAppFrames: filters minified stacks to relevant app frames
 * - parseBrowserInfo: lightweight UA string → browser name/version
 *
 * Use vi.importActual() so the real implementations are loaded without
 * removing the analytics mock from the shared module registry
 * (isolate: false — removing the mock here would poison other test files).
 */

// The real functions are imported via importActual to avoid poisoning the analytics mock
let extractAppFrames: (stack: string) => string;
let parseBrowserInfo: (ua: string) => string;

beforeAll(async () => {
  const mod = await vi.importActual<typeof import('@/services/analytics')>('@/services/analytics');
  extractAppFrames = mod.extractAppFrames;
  parseBrowserInfo = mod.parseBrowserInfo;
});

describe('extractAppFrames', () => {
  it('returns empty string for empty/undefined input', () => {
    expect(extractAppFrames('')).toBe('');
  });

  it('extracts app frames from a typical stack trace', () => {
    const stack = `Error: Something failed
    at calculateTax (src/services/calculationService.ts:142:8)
    at Object.runCalc (node_modules/react/cjs/react.development.js:1234:5)
    at handleClick (src/components/Calculator.tsx:55:12)
    at HTMLButtonElement.dispatch (node_modules/react-dom/cjs/react-dom.development.js:3456:7)`;

    const result = extractAppFrames(stack);
    expect(result).toContain('calculationService.ts:142:8');
    expect(result).toContain('Calculator.tsx:55:12');
    expect(result).not.toContain('node_modules');
    expect(result).toContain(' → ');
  });

  it('handles minified production stacks with /assets/ paths', () => {
    const stack = `TypeError: Cannot read properties of undefined
    at https://frontaliereticino.ch/assets/index-abc123.js:1:23456
    at https://frontaliereticino.ch/assets/services-def456.js:2:789`;

    const result = extractAppFrames(stack);
    expect(result).toContain('index-abc123.js:1:23456');
  });

  it('limits to 3 frames max', () => {
    const stack = `Error: test
    at a (src/components/A.tsx:1:1)
    at b (src/components/B.tsx:2:2)
    at c (src/components/C.tsx:3:3)
    at d (src/components/D.tsx:4:4)`;

    const frames = extractAppFrames(stack).split(' → ');
    expect(frames.length).toBeLessThanOrEqual(3);
  });

  it('filters out webpack/chunk internals', () => {
    const stack = `Error: fail
    at Module.callback (webpack:///./src/index.ts:10:5)
    at chunk-ABCDEF.js:1:100
    at render (src/components/App.tsx:30:10)`;

    const result = extractAppFrames(stack);
    expect(result).not.toContain('webpack');
    expect(result).not.toContain('chunk-ABCDEF');
    expect(result).toContain('App.tsx:30:10');
  });

  it('truncates result to 200 chars max', () => {
    const longFrames = Array.from({ length: 3 }, (_, i) =>
      `    at func${i} (src/components/VeryLongComponentNameThatGoesOnAndOn${i}.tsx:${i + 1}:${i + 1})`
    ).join('\n');
    const stack = `Error: test\n${longFrames}`;

    expect(extractAppFrames(stack).length).toBeLessThanOrEqual(200);
  });

  it('handles Firefox-style stacks (func@url:line:col)', () => {
    const stack = `doSomething@https://frontaliereticino.ch/assets/index-abc.js:10:20
handleError@https://frontaliereticino.ch/assets/services-xyz.js:5:15`;

    const result = extractAppFrames(stack);
    expect(result).toContain('index-abc.js:10:20');
  });
});

describe('parseBrowserInfo', () => {
  it('returns "unknown" for empty UA', () => {
    expect(parseBrowserInfo('')).toBe('unknown');
  });

  it('detects Chrome', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    expect(parseBrowserInfo(ua)).toBe('Chrome/125.0.0.0');
  });

  it('detects Firefox', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0';
    expect(parseBrowserInfo(ua)).toBe('Firefox/126.0');
  });

  it('detects Safari on macOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    expect(parseBrowserInfo(ua)).toBe('Safari/17.5');
  });

  it('detects Edge (not Chrome)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 Edg/125.0';
    expect(parseBrowserInfo(ua)).toBe('Edge/125.0');
  });

  it('detects Opera (not Chrome)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 OPR/111.0';
    expect(parseBrowserInfo(ua)).toBe('Opera/111.0');
  });

  it('detects Chrome on iOS (CriOS)', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1';
    expect(parseBrowserInfo(ua)).toBe('Chrome-iOS/125.0');
  });

  it('detects Samsung Browser', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125.0 SamsungBrowser/25.0 Safari/537.36';
    expect(parseBrowserInfo(ua)).toBe('Samsung/25.0');
  });

  it('returns "other" for unrecognized UA', () => {
    expect(parseBrowserInfo('SomeBot/1.0')).toBe('other');
  });
});
