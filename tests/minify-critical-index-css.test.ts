import { describe, expect, it } from 'vitest';

import { minifyRootCriticalIndexCss } from '@/build-plugins/minifyCriticalIndexCss';

describe('root critical CSS minifier', () => {
  it('minifies only the first-paint style block', async () => {
    const source = [
      '<head>',
      '<style data-clarity-unmask="true"> /* critical */ body { margin: 0; color: red; } </style>',
      '<style>.keep-readable { color: blue; }</style>',
      '</head>',
    ].join('');

    const output = await minifyRootCriticalIndexCss(source);

    expect(output).toContain('<style data-clarity-unmask="true">body{margin:0;color:red}</style>');
    expect(output).toContain('<style>.keep-readable { color: blue; }</style>');
    expect(output).toContain('<head>');
    expect(output).toContain('</head>');
  });

  it('leaves documents without the marked root style unchanged', async () => {
    const source = '<head><style>body { margin: 0; }</style></head>';
    await expect(minifyRootCriticalIndexCss(source)).resolves.toBe(source);
  });
});
