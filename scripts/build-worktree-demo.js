const path = require('path');
const { buildWorktreeDemo } = require('../tests/helpers/worktree-demo');

const target = path.join(__dirname, '..', 'tests', 'fixtures', 'worktree-group-demo');
const paths = buildWorktreeDemo(target);

console.log('Built worktree grouping demo at', target);
console.log(JSON.stringify(paths, null, 2));
console.log('\nOpen the folder above in Claude Code (or `cd` into each subproject) to register them as');
console.log('projects, then check the Projects tab in Claude Manager to see the grouping.');
