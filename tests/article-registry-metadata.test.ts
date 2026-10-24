import { describe, expect, it } from 'vitest';
import { readArticleRegistryMetadata } from '../packages/articles/engine/shared/articleRegistryMetadata';

describe('article registry metadata boundaries', () => {
  it('never borrows revision or author metadata from the next article', () => {
    const records = readArticleRegistryMetadata(`const RAW_ARTICLES = [
      {id:'precedente', category:'pratico', date:'2026-10-01'},
      {id:'ticino-rimborso-lpp-2024', category:'pensione', date:'2024-01-01', updatedAt:'2026-10-03', image:'/lpp.webp', authorSlug:'redazione', authorName:'Redazione'},
      {id:'successivo', category:'novita', date:'2026-10-02'},
    ];`);
    expect(records).toEqual([
      {id:'precedente',category:'pratico',date:'2026-10-01'},
      {id:'ticino-rimborso-lpp-2024',category:'pensione',date:'2024-01-01',updatedAt:'2026-10-03',image:'/lpp.webp',authorSlug:'redazione',authorName:'Redazione'},
      {id:'successivo',category:'novita',date:'2026-10-02'},
    ]);
  });
  it('ignores comments, nested objects, strings and templates containing fake metadata', () => {
    const source = "const RAW_ARTICLES = [{id:'one', description: 'id: fake, updatedAt: bad }', nested: {updatedAt:'wrong'}, related:[{id:'nested',updatedAt:'wrong'}], template: `id: fake ${ {updatedAt:'fake'} }`, /* updatedAt:'comment' */ authorName:\"D’Angelo\"}, {updatedAt: /* actual */ '2026-10-03',id:'two'}];";
    expect(readArticleRegistryMetadata(source)).toEqual([{id:'one',authorName:'D’Angelo'}, {id:'two',updatedAt:'2026-10-03'}]);
  });
  it('rejects duplicate ids and truncated registry objects instead of merging entries', () => {
    expect(() => readArticleRegistryMetadata("const A=[{id:'a'},{id:'a'}];")).toThrow(/Duplicate/);
    expect(() => readArticleRegistryMetadata("const A=[{id:'a'}")).toThrow(/Unbalanced/);
  });

  it('rejects dynamic values for recognized metadata instead of returning a partial record', () => {
    expect(() => readArticleRegistryMetadata(
      "const A=[{id: runtimeId, category:'pratico', date:'2026-10-01'}];",
    )).toThrow(/static string/i);
  });

  it('preserves explicit article provenance and rejects dynamic booleans', () => {
    expect(readArticleRegistryMetadata(
      "const A=[{id:'with-ai', aiAssisted:true},{id:'without-ai', aiAssisted:false}];",
    )).toEqual([
      { id: 'with-ai', aiAssisted: true },
      { id: 'without-ai', aiAssisted: false },
    ]);
    expect(() => readArticleRegistryMetadata(
      "const A=[{id:'dynamic', aiAssisted: runtimeValue}];",
    )).toThrow(/static boolean/i);
  });
});
