import { decode } from 'html-entities';

/** Decode one layer of complete HTML references without corrupting Unicode scalars. */
export function decodeHtmlText(value: string): string {
  return value.replace(/&(?:#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]*);/g, (entity) => {
    if (entity.startsWith('&#')) {
      const hex = /^&#x/i.test(entity);
      const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
      // html-entities 2.x rejects the maximum valid scalar; retain it here.
      if (code === 0x10ffff) return String.fromCodePoint(code);
    }
    return decode(entity, { scope: 'strict' });
  });
}
