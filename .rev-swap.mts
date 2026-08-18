import { buildComuneEvergreenTopics } from './scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES as SITE_M } from './data/municipalities';
import { MUNICIPALITIES as CORPUS_M } from '/Users/saggesel/Projects/frontaliere/frontaliere-articles/.claude/worktrees/evergreen-cap/generator/data/municipalities';
console.log('site code + site data  :', buildComuneEvergreenTopics(SITE_M as never).length);
console.log('site code + corpus data:', buildComuneEvergreenTopics(CORPUS_M as never).length);
