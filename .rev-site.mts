import { buildComuneEvergreenTopics, resolveComuneCanton } from './scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES } from './data/municipalities';
const M: any[] = MUNICIPALITIES as any;
console.log('rows', M.length);
const byC: Record<string, any[]> = {};
let unresolved = 0;
for (const m of M) {
  const c = resolveComuneCanton(m);
  if (!c || !m?.name) { unresolved++; continue; }
  (byC[c] ||= []).push(m);
}
console.log('unresolved/no-name', unresolved);
for (const [c, l] of Object.entries(byC)) {
  const sel = l.filter((m:any)=> typeof m.distanceKm==='number' && m.distanceKm<=30);
  const bad = l.filter((m:any)=> typeof m.distanceKm!=='number');
  const nan = l.filter((m:any)=> typeof m.distanceKm==='number' && Number.isNaN(m.distanceKm));
  console.log(c, 'total', l.length, 'sel<=30', sel.length, 'non-number dist', bad.length, 'NaN', nan.length);
}
const computed = buildComuneEvergreenTopics(M as never);
console.log('computed total', computed.length);
// duplicate names?
const names = computed.map((t:any)=>t.keyword);
console.log('unique keywords', new Set(names).size);
// max distances
const all = Object.values(byC).flat();
console.log('rows with distanceKm missing overall', all.filter((m:any)=>typeof m.distanceKm!=='number').length);
