// Line diff shared by the file-history views and the git panel: both need the same hunks in the
// same shape, and the client renderer (FileHistory.renderDiff) reads that shape.

const MAX_LINES = 5000;

function computeDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length, n = b.length;

  if (m > MAX_LINES || n > MAX_LINES) {
    return { hunks: [], stats: { added: 0, removed: 0 }, tooLarge: true };
  }

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }

  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      ops.push({ t: '=', c: a[i-1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      ops.push({ t: '+', c: b[j-1] });
      j--;
    } else {
      ops.push({ t: '-', c: a[i-1] });
      i--;
    }
  }
  ops.reverse();

  const CTX = 3;
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
    let oldLine = 1, newLine = 1;
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
