import path from 'node:path';

import { relatedSearchClustersPlugin } from '../build-plugins/relatedSearchClustersPlugin';
import { resolveJobsSeoPagesFlushed } from '../build-plugins/shared/buildSignals';

const outputPath = process.env.RELATED_SEARCH_CLUSTERS_SUMMARY_OUT;
if (!outputPath) {
  throw new Error('RELATED_SEARCH_CLUSTERS_SUMMARY_OUT is required');
}

// The summary-only plugin path performs the same exact all-locale matching as
// a monolithic build, then serializes only the metadata foreign shards need.
// There is no jobs-seo producer in this prep process, so resolve its barrier
// explicitly; the production build keeps the normal producer/consumer barrier.
resolveJobsSeoPagesFlushed();
const plugin = relatedSearchClustersPlugin(process.cwd());
const closeBundle = plugin.closeBundle;
if (typeof closeBundle !== 'function') {
  throw new Error('related-search-clusters plugin has no callable closeBundle hook');
}
await closeBundle.call(plugin);

console.log(`related-search-clusters summary ready: ${path.resolve(outputPath)}`);
