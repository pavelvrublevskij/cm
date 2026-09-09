console.log('\n=== diff.computeDiff ===');
require('./diff.bench').run();

console.log('\n=== session-activity.collectFromJsonl ===');
require('./session-activity.bench').run();

console.log('\n=== usage-index.parseSessionUsage ===');
require('./usage-index.bench').run();
