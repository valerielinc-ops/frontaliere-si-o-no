/**
 * Regression: i blocchi statici della home (rail di discovery + pannello SEO)
 * devono comparire SOPRA il footer, non dopo il copyright.
 *
 * Il build li emette in fondo al <body>, dopo #root, perche' restino fuori
 * dalla riconciliazione React e leggibili senza JavaScript. Il footer vive
 * dentro #root: senza adozione quei blocchi finivano sotto di lui (misurato in
 * produzione il 2026-10-07: footer fino a 8307px, blocchi da 8307px in giu').
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import StaticPrefooterSlot, { resetStaticPrefooterForTests } from '@/components/shared/StaticPrefooterSlot';

const STATIC_BLOCKS = `
  <section class="homepage-discovery" id="homepage-discovery"><a href="/farmacie/">Farmacie e turni</a></section>
  <aside id="hp-seo-block" class="seo-footer-block"><a href="/traffico-dogane/">tempi attesa dogane</a></aside>`;

function Page({ pathname }: { pathname: string }) {
  return (
    <>
      <main>contenuto</main>
      <StaticPrefooterSlot pathname={pathname} originPath="/" />
      <footer>footer</footer>
    </>
  );
}

describe('StaticPrefooterSlot', () => {
  let leftovers: Element[] = [];

  beforeEach(() => {
    resetStaticPrefooterForTests();
    const holder = document.createElement('div');
    holder.innerHTML = STATIC_BLOCKS;
    leftovers = Array.from(holder.children);
    for (const node of leftovers) document.body.appendChild(node);
  });

  afterEach(() => {
    cleanup();
    for (const node of leftovers) node.remove();
  });

  it('sposta i blocchi statici prima del footer, nello stesso ordine', () => {
    const { container } = render(<Page pathname="/" />);
    const slot = container.querySelector('.static-prefooter')!;
    const footer = container.querySelector('footer')!;

    expect(Array.from(slot.children).map((node) => node.id)).toEqual(['homepage-discovery', 'hp-seo-block']);
    // Node.DOCUMENT_POSITION_FOLLOWING: il footer viene dopo lo slot.
    expect(slot.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('body > #homepage-discovery')).toBeNull();
  });

  it('non perde nessun link: restano nel documento dopo l’adozione', () => {
    render(<Page pathname="/" />);
    expect(document.querySelector('a[href="/farmacie/"]')).not.toBeNull();
    expect(document.querySelector('a[href="/traffico-dogane/"]')).not.toBeNull();
  });

  it('nasconde i blocchi lontano dalla pagina d’origine e li rimostra al ritorno', () => {
    const { container, rerender } = render(<Page pathname="/" />);
    const slot = container.querySelector<HTMLElement>('.static-prefooter')!;
    expect(slot.hidden).toBe(false);

    rerender(<Page pathname="/compara-servizi/" />);
    expect(slot.hidden).toBe(true);
    // Il re-render non deve aver staccato i nodi adottati.
    expect(slot.children).toHaveLength(2);

    rerender(<Page pathname="/" />);
    expect(slot.hidden).toBe(false);
  });

  it('riappende i blocchi quando lo slot viene rimontato in un altro contenitore', () => {
    const first = render(<Page pathname="/" />);
    first.unmount();
    expect(document.querySelector('#homepage-discovery')).toBeNull();

    const second = render(<Page pathname="/" />);
    expect(second.container.querySelector('.static-prefooter #homepage-discovery')).not.toBeNull();
    expect(second.container.querySelector('.static-prefooter #hp-seo-block')).not.toBeNull();
  });

  it('ignora i blocchi annidati: adotta solo i figli diretti di <body>', () => {
    const wrapper = document.createElement('main');
    wrapper.innerHTML = '<aside class="seo-footer-block" id="nested">annidato</aside>';
    document.body.appendChild(wrapper);
    leftovers.push(wrapper);

    const { container } = render(<Page pathname="/" />);
    expect(container.querySelector('.static-prefooter #nested')).toBeNull();
    expect(wrapper.querySelector('#nested')).not.toBeNull();
  });
});
