import { MUNICIPALITIES } from './data/municipalities';
import { borderCrossings } from './data/borderCrossings';
import { haversineKm } from './scripts/lib/haversine.mjs';
const M: any[] = MUNICIPALITIES as any;
const C: any[] = borderCrossings as any;
function nearest(m:any){ let best=1e9, bc=null; for(const c of C){const d=haversineKm(m.lat,m.lng,c.lat,c.lng); if(d<best){best=d;bc=c;}} return {km:best, c:bc}; }
const rows = M.map(m=>{const n=nearest(m); return {name:m.name, prov:m.province, d:m.distanceKm, h:n.km, cross:n.c.name, cc:n.c.canton};});
const diffs = rows.map(r=>Math.abs(r.d-r.h));
diffs.sort((a,b)=>a-b);
console.log('|distanceKm - haversine| median', diffs[Math.floor(diffs.length/2)].toFixed(1), 'p90', diffs[Math.floor(diffs.length*0.9)].toFixed(1), 'max', diffs[diffs.length-1].toFixed(1));
console.log('worst 10:');
for (const r of rows.sort((a,b)=>Math.abs(b.d-b.h)-Math.abs(a.d-a.h)).slice(0,10)) console.log(`  ${r.name} (${r.prov}) distanceKm=${r.d} haversine=${r.h.toFixed(1)} to ${r.cross} [${r.cc}]`);
console.log('--- Lecco-shore examples ---');
for (const n of ['Colico','Bellano','Varenna','Bosisio Parini','Rogeno','Costa Masnaga','Mandello del Lario']) {
  const r = rows.find(x=>x.name===n)!; console.log(`  ${r.name} distanceKm=${r.d} haversine=${r.h.toFixed(1)} to ${r.cross} [${r.cc}]`);
}
