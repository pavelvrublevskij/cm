// Line diff shared by the file-history views and the git panel: both need the same hunks in the
// same shape, and the client renderer (FileHistory.renderDiff) reads that shape.

const MAX_LINES = 8000;
const CTX = 3;

function computeDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length, n = b.length;

  // Most diffs here are "recorded snapshot vs. current file": the vast majority of lines are
  // untouched, only shifted apart by whatever changed in between. Trimming the matching prefix
  // and suffix first means the expensive DP below only ever runs over the differing region, not
  // the whole file — a file with a million untouched lines and five changed ones diffs instantly.
  let prefix = 0;
  while (prefix < m && prefix < n && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(m, n) - prefix;
  while (suffix < maxSuffix && a[m - 1 - suffix] === b[n - 1 - suffix]) suffix++;

  // Leave CTX lines of matched buffer on each side of the trim so hunks bordering the trimmed
  // region still get their surrounding context, exactly as if nothing had been trimmed.
  const coreStart = Math.max(0, prefix - CTX);
  const coreEndBack = Math.max(0, suffix - CTX);
  const a2 = a.slice(coreStart, m - coreEndBack);
  const b2 = b.slice(coreStart, n - coreEndBack);
  const m2 = a2.length, n2 = b2.length;

  if (m2 > MAX_LINES || n2 > MAX_LINES) {
    return { hunks: [], stats: { added: 0, removed: 0 }, tooLarge: true };
  }

  const dp = Array.from({ length: m2 + 1 }, () => new Uint16Array(n2 + 1));
  for (let i = 1; i <= m2; i++) {
    for (let j = 1; j <= n2; j++) {
      dp[i][j] = a2[i-1] === b2[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }

  const ops = [];
  let i = m2, j = n2;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a2[i-1] === b2[j-1]) {
      ops.push({ t: '=', c: a2[i-1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      ops.push({ t: '+', c: b2[j-1] });
      j--;
    } else {
      ops.push({ t: '-', c: a2[i-1] });
      i--;
    }
  }
  ops.reverse();

  const inHunk = new Set();
  let added = 0, removed = 0;
  ops.forEach((op, idx) => {
    if (op.t !== '=') {
      for (let k = Math.max(0, idx - CTX); k <= Math.min(ops.length - 1, idx + CTX); k++) {
        inHunk.add(k);
      }
      if (op.t === '+') added++;
      else removed++;
    }
  });

  if (!inHunk.size) return { hunks: [], stats: { added: 0, removed: 0 } };

  const ranges = [];
  let rs = -1;
  for (let k = 0; k < ops.length; k++) {
    if (inHunk.has(k)) {
      if (rs === -1) rs = k;
    } else if (rs !== -1) {
      ranges.push([rs, k - 1]);
      rs = -1;
    }
  }
  if (rs !== -1) ranges.push([rs, ops.length - 1]);

  const hunks = ranges.map(([start, end]) => {
    let oldLine = coreStart + 1, newLine = coreStart + 1;
    for (let k = 0; k < start; k++) {
      if (ops[k].t !== '+') oldLine++;
      if (ops[k].t !== '-') newLine++;
    }
    const lines = [];
    for (let k = start; k <= end; k++) {
      lines.push({ type: ops[k].t, content: ops[k].c });
    }
    return { oldStart: oldLine, newStart: newLine, lines };
  });

  return { hunks, stats: { added, removed } };
}

module.exports = { computeDiff, MAX_LINES };
