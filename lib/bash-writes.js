const path = require('path');

const SCRIPT_WRITE_RE = /\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"][wax]\+?b?['"]|\.write_text\(|\.write_bytes\(|\bwriteFile(?:Sync)?\(|\bappendFile(?:Sync)?\(|\bwriteFileSync\(/;
const PATH_LITERAL_RE = /['"]([^'"\r\n]*[\w)\]][^'"\r\n]*)['"]/g;
const WS_CMDLET_RE = /^(?:Set-Content|Add-Content|Out-File|New-Item)\b(.*)$/i;

function tokenize(str) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return tokens;
}

function msysToNative(p) {
  if (process.platform !== 'win32') return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

function looksLikePath(s) {
  return !/\s{2,}|[<>|*?{}$`]/.test(s) && /[\w]\.[A-Za-z0-9]{1,8}$/.test(s) && s.length < 260;
}

/**
 * Best-effort recovery of files a Bash/PowerShell command wrote to: `sed -i`, `>`/`>>` redirects,
 * `tee`, `cp`/`mv` destinations, Set-Content-style cmdlets, and path literals in python/node
 * scripts that open files for writing. Returns [{ cwd, target }]; `cwd` is the last `cd` seen in
 * the same command ('' if none). Callers must confirm each candidate against disk.
 */
function extractBashWrites(command) {
  const cmd = command || '';
  const out = [];
  let cwd = '';
  const add = (target) => {
    if (target && !target.startsWith('-') && !/^&?\d*$/.test(target) && target !== '/dev/null' && target !== 'NUL') {
      out.push({ cwd, target: msysToNative(target) });
    }
  };

  for (const stmt of cmd.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean)) {
    const cd = stmt.match(/^cd\s+(?:\/d\s+)?(\S+)/i);
    if (cd) { cwd = msysToNative(cd[1].replace(/^["']|["']$/g, '')); continue; }

    for (const r of stmt.matchAll(/(?:^|[^<>\d&])\d?>>?\s*("[^"]+"|'[^']+'|[^\s|&;<>]+)/g)) add(r[1].replace(/^["']|["']$/g, ''));

    const sed = stmt.match(/^sed\s+(.*)$/);
    if (sed && /(^|\s)-[a-zA-Z]*i/.test(' ' + sed[1]) || sed && /--in-place/.test(sed[1])) {
      const toks = tokenize(sed[1]).filter(t => !t.startsWith('-'));
      toks.slice(1).forEach(add);
      continue;
    }
    const tee = stmt.match(/\btee\s+(.*)$/);
    if (tee) tokenize(tee[1]).filter(t => !t.startsWith('-')).forEach(add);

    const cp = stmt.match(/^(?:cp|mv|copy|move)\s+(.*)$/i);
    if (cp) {
      const toks = tokenize(cp[1]).filter(t => !t.startsWith('-'));
      if (toks.length >= 2) add(toks[toks.length - 1]);
      continue;
    }
    const ws = stmt.match(WS_CMDLET_RE);
    if (ws) {
      const toks = tokenize(ws[1]);
      const i = toks.findIndex(t => /^-(?:Path|FilePath|LiteralPath)$/i.test(t));
      add(i >= 0 ? toks[i + 1] : toks.find(t => !t.startsWith('-')));
    }
  }

  if (SCRIPT_WRITE_RE.test(cmd)) {
    for (const m of cmd.matchAll(PATH_LITERAL_RE)) if (looksLikePath(m[1])) add(m[1]);
  }
  return out;
}

module.exports = { extractBashWrites };
