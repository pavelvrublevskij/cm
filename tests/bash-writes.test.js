const { test } = require('node:test');
const assert = require('node:assert');
const { extractBashWrites } = require('../lib/bash-writes');

const targets = (cmd) => extractBashWrites(cmd).map(w => w.target);

test('sed -i yields the file operands, not the script', () => {
  assert.deepStrictEqual(targets('sed -i "s/a/b/" src/a.h && sed -n 1,6p src/other.h'), ['src/a.h']);
});

test('redirects, tee and cp/mv destinations are detected', () => {
  assert.deepStrictEqual(targets('echo hi > out/a.txt; cat x | tee -a b.log; cp a.js dir/b.js'), ['out/a.txt', 'b.log', 'dir/b.js']);
});

test('python write script yields path literals and the preceding cd', () => {
  const w = extractBashWrites("cd sub && python - <<'EOF'\np='SPEC.md'\nopen(p,'w').write(s)\nEOF");
  assert.deepStrictEqual(w, [{ cwd: 'sub', target: 'SPEC.md' }]);
});

test('read-only commands yield nothing', () => {
  assert.deepStrictEqual(targets('grep -n foo src/a.cpp && cat src/b.cpp'), []);
  assert.deepStrictEqual(targets("python -c \"print(open('x.txt').read())\""), []);
});
