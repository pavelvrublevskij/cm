// Line diff shared by the file-history views and the git panel: both need the same hunks in the
// same shape, and the client renderer (FileHistory.renderDiff) reads that shape.

const MAX_LINES = 8000;
const CTX = 3;

// The old O(m*n) DP LCS blew past a couple of seconds once the differing region held even a
// few hundred scattered edits (each dp[i][j] cell needs computing regardless of how similar the
// texts are). Myers' O(ND) algorithm instead costs time proportional to the edit distance D, so
// two mostly-identical texts stay fast no matter how large the differing region trimmed above is.
// D is capped at MAX_LINES for the same reason MAX_LINES bounds the DP: past that many edits the
// texts aren't "a small diff in a big file" anymore, and bailing out to tooLarge is cheaper and
// more useful than rendering an enormous diff.
function shortestEditScript(a, b, maxD) {
  const n = a.length, m = b.length;
  const v = new Int32Array(2 * maxD + 1);
  const trace = [];

  for (let d = 0; d <= maxD; d++) {
    // Backtracking at depth d reads v[k-1]/v[k+1] for k in [-d, d], which can reach one slot
    // past that range (e.g. k=-d needs v[k+1]) — pad the stored window by 1 on each side so that
    // read is always in-bounds, clamped to v's own [-maxD, maxD] extent.
    const lo = Math.max(-maxD, -d - 1);
    const hi = Math.min(maxD, d + 1);
    trace.push({ arr: v.slice(maxD + lo, maxD + hi + 1), lo });

    for (let k = -d; k <= d; k += 2) {
      const idx = k + maxD;
      let x;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1];
      } else {
        x = v[idx - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[idx] = x;
      if (x >= n && y >= m) return backtrackEditScript(a, b, trace, d);
    }
  }
  return null;
}

function backtrackEditScript(a, b, trace, finalD) {
  let x = a.length, y = b.length;
  const ops = [];

  for (let d = finalD; d >= 0; d--) {
    const { arr, lo } = trace[d];
    const at = kk => arr[kk - lo];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ t: '=', c: a[x - 1] });
      x--; y--;
    }

    if (d > 0) {
      if (x === prevX) {
        ops.push({ t: '+', c: b[y - 1] });
        y--;
      } else {
        ops.push({ t: '-', c: a[x - 1] });
        x--;
      }
    }
  }

  ops.reverse();
  return ops;
}

// git normalizes CRLF/LF per its own autocrlf/gitattributes rules before comparing; the callers here
// read one side straight from the blob and the other straight off disk, so on a checkout where the
// working tree uses CRLF and the blob stores LF (the common Windows case), every line would otherwise
// differ only in its trailing \r — the whole file reads as rewritten instead of the real few-line edit.
function normalizeLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function computeDiff(oldText, newText) {
  const a = normalizeLines(oldText);
  const b = normalizeLines(newText);
  const m = a.length, n = b.length;

  // Most diffs here are "recorded snapshot vs. current file": the vast majority of lines are
  // untouched, only shifted apart by whatever changed in between. Trimming the matching prefix
  // and suffix first means the edit-script search below only ever runs over the differing region, not
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

  const ops = shortestEditScript(a2, b2, MAX_LINES);
  if (!ops) {
    return { hunks: [], stats: { added: 0, removed: 0 }, tooLarge: true };
  }

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
