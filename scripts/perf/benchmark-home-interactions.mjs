#!/usr/bin/env node
/**
 * Start home-lab.vite.config.mjs first; this driver saves Event Timing and CDP trace.
 * node scripts/perf/benchmark-home-interactions.mjs --label before --out tmp/home-before
 * Five salary edits (80000..84000), mobile 390x844, Chrome CPU 4x; third parties blocked.
 */
import {chromium} from 'playwright';import fs from 'node:fs/promises';
const args=process.argv.slice(2);
const option=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
const label=option('--label')||'working-tree';
const origin=option('--url')||'http://127.0.0.1:4319';
const output=option('--out')||'tmp/home-interactions';
await fs.mkdir(output,{recursive:true});
const b=await chromium.launch({headless:true,channel:'chrome'});
const p=await b.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
await p.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
p.on('pageerror',e=>console.log('ERROR',e.message.slice(0,200)));
const cdp=await p.context().newCDPSession(p);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
await p.addInitScript(()=>{window.evs=[];window.tasks=[];new PerformanceObserver(l=>window.evs.push(...l.getEntries().map(e=>({name:e.name,duration:e.duration,start:e.startTime,id:e.interactionId})))).observe({type:'event',durationThreshold:16,buffered:true});new PerformanceObserver(l=>window.tasks.push(...l.getEntries().map(e=>({duration:e.duration,start:e.startTime})))).observe({type:'longtask',buffered:true});});
try{
await p.goto(origin);await p.waitForSelector('#mc-salary',{timeout:60000});await p.waitForTimeout(5000);
console.log('nodes',await p.locator('*').count(),'salary',await p.locator('#mc-salary').inputValue());
await cdp.send('Tracing.start',{categories:'devtools.timeline,v8.execute,disabled-by-default-v8.cpu_profiler',transferMode:'ReturnAsStream'});
const rows=[];const field=p.locator('#mc-salary');await field.scrollIntoViewIfNeeded();await field.focus();
for(let i=0;i<5;i++){
await field.selectText();await p.evaluate(()=>{window.evs=[];window.tasks=[];window.start=performance.now()});await field.pressSequentially(String(80000+i*1000),{delay:150});await p.waitForTimeout(600);rows.push(await p.evaluate(()=>({events:window.evs.filter(e=>e.start>=window.start),tasks:window.tasks.filter(e=>e.start>=window.start),nodes:document.querySelectorAll('*').length,desktopInputs:document.querySelectorAll('#input-age-compact').length,salary:document.querySelector('#mc-salary').value})));
}
const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const {stream}=await done;let trace='';for(;;){const x=await cdp.send('IO.read',{handle:stream});trace+=x.data;if(x.eof)break;}await cdp.send('IO.close',{handle:stream});await fs.writeFile(`${output}/trace.json`,trace);await fs.writeFile(`${output}/measurements.json`,JSON.stringify({label,browser:b.version(),viewport:"390x844",cpuSlowdown:4,scope:"Real homepage via Vite with production React; external requests blocked; not a deployed-bundle/field-INP measurement",records:rows},null,2));console.log(rows.map(r=>({maxEvent:Math.max(0,...r.events.map(e=>e.duration)),maxTask:Math.max(0,...r.tasks.map(e=>e.duration)),nodes:r.nodes,desktopInputs:r.desktopInputs,salary:r.salary})));
}finally{await b.close();}
