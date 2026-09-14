const path = require('path');
const crypto = require('crypto');
const { gitCommonDir, realProjectPath, isMainWorktree, isSymlinkPath, findSymlinks } = require('./worktree-group');
const { listProjectDirs } = require('./project-list');

function hashKey(prefix, value) {
  const hash = crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
  return `${prefix}:${hash}`;
}

/** Windows paths compare case-insensitively; everywhere else they don't. */
function normalizePath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `child` lives strictly inside `parent` (not equal to it). */
function isStrictSubPath(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c !== p && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function makeUnionFind(keys) {
  const parent = new Map(keys.map(k => [k, k]));
  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  return { find, union };
}

/** Merge every project that `keyOf` maps to the same non-null key. */
function unionByKey(uf, projects, keyOf) {
  const firstForKey = new Map();
  for (const p of projects) {
    const key = keyOf(p);
    if (key === null || key === undefined) continue;
    if (firstForKey.has(key)) uf.union(firstForKey.get(key), p.slug);
    else firstForKey.set(key, p.slug);
  }
}

/** What grouping needs to know about each project, resolved from disk once up front. */
function describeProjects(projects) {
  return projects.map(p => ({
    slug: p.slug,
    path: p.path,
    gitKey: gitCommonDir(p.path),
    realPath: realProjectPath(p.path)
  }));
}

/**
 * Merges any project containing a symlink to another registered project, e.g. an umbrella
 * workspace's "project-repos/" folder linking to sibling repos.
 *
 * Returns the extra facts this pass discovers:
 *   - `referrers`: projects that link out to another, i.e. the natural hub of their group
 *   - `appearancesOf`: every path a project is visible at — its own, plus each symlink resolving
 *     to it, which is what lets the tree nest a linked-in repo where the user actually sees it
 */
function linkSymlinkedProjects(uf, described) {
  const appearancesOf = new Map(described.map(p => [p.slug, [p.path]]));
  const referrers = new Set();
  const slugByRealPath = new Map(described.map(p => [p.realPath, p.slug]));

  for (const p of described) {
    for (const { linkPath, target } of findSymlinks(p.path)) {
      const targetSlug = slugByRealPath.get(target);
      if (!targetSlug || targetSlug === p.slug) continue;
      uf.union(p.slug, targetSlug);
      referrers.add(p.slug);
      appearancesOf.get(targetSlug).push(linkPath);
    }
  }
  return { referrers, appearancesOf };
}

/**
 * The project a group is built around, in order of preference:
 *   1. one that links out to the others — two independently-rooted git repos merged by a symlink
 *      both look like main worktrees, so only the link direction tells them apart
 *   2. an actual main worktree, over the linked worktrees sharing its .git
 *   3. for a pure symlink-alias pair with no git involved, whichever side isn't the symlink —
 *      realpath equality can't decide this, being trivially true for every real directory
 */
function pickPrimary(slugs, bySlug, referrers) {
  return slugs.find(s => referrers.has(s))
    || slugs.find(s => isMainWorktree(bySlug.get(s).path))
    || slugs.find(s => !isSymlinkPath(bySlug.get(s).path))
    || slugs[0];
}

/**
 * Nests a group's members by real folder containment, so the sidebar can draw the hierarchy the
 * user sees on disk. Only registered projects are ever nodes: a project sitting at
 * `<workspace>/linked-repos/service` hangs directly off `<workspace>` with a relative path of
 * "linked-repos/service", since "linked-repos" is not itself a project. A project is matched
 * against every path it appears at and takes the deepest containing project as its parent. Members
 * with no containing project (a git worktree lives beside its repo, not inside it) stay roots.
 *
 * Returns { parentOf: Map<slug, slug>, relOf: Map<slug, string> }.
 */
function computeNesting(memberSlugs, bySlug, appearancesOf) {
  const parentOf = new Map();
  const relOf = new Map();

  for (const slug of memberSlugs) {
    let best = null;
    for (const appearance of appearancesOf.get(slug) || []) {
      for (const otherSlug of memberSlugs) {
        if (otherSlug === slug) continue;
        const basePath = bySlug.get(otherSlug).path;
        if (!isStrictSubPath(appearance, basePath)) continue;
        if (!best || basePath.length > best.baseLength) {
          best = { parentSlug: otherSlug, baseLength: basePath.length, rel: path.relative(basePath, appearance) };
        }
      }
    }
    if (best) {
      parentOf.set(slug, best.parentSlug);
      relOf.set(slug, best.rel.split(path.sep).join('/'));
    }
  }

  // Symlinks can point both ways between two projects, which would make each the other's parent
  // and leave the tree unrenderable. Any slug that can reach itself by walking up becomes a root.
  for (const slug of memberSlugs) {
    const seen = new Set([slug]);
    for (let cursor = parentOf.get(slug); cursor !== undefined; cursor = parentOf.get(cursor)) {
      if (seen.has(cursor)) {
        parentOf.delete(slug);
        relOf.delete(slug);
        break;
      }
      seen.add(cursor);
    }
  }

  return { parentOf, relOf };
}

/** Group every project by its union-find root, keyed by a stable hash of that root. */
function collectComponents(uf, described) {
  const membersOf = new Map();
  for (const p of described) {
    const id = hashKey('auto', uf.find(p.slug));
    if (!membersOf.has(id)) membersOf.set(id, []);
    membersOf.get(id).push(p.slug);
  }
  return membersOf;
}

/**
 * Assigns each project a groupId/groupLabel/groupPrimary, plus groupParentSlug/groupRelPath
 * describing where it sits in the group's folder hierarchy. Three things auto-group a set of
 * projects together (any pair sharing one of these transitively merges the whole set, via a
 * union-find over all three):
 *   - git worktrees sharing a repo's common .git dir
 *   - non-git projects that resolve to the same real path (symlink aliases)
 *   - a project whose directory tree contains a symlink pointing at another registered project —
 *     see lib/worktree-group.js's findSymlinks for the scan's bounds
 * A component left with fewer than two live members — because the other worktree is gone, say —
 * falls back to ungrouped rather than showing a "group" of one.
 *
 * Returns a Map: slug -> { groupId, groupLabel, groupPrimary, groupParentSlug, groupRelPath }.
 * Slugs with no entry are ungrouped.
 */
function computeGroups(projects) {
  const described = describeProjects(projects);
  const bySlug = new Map(described.map(p => [p.slug, p]));
  const uf = makeUnionFind(described.map(p => p.slug));

  unionByKey(uf, described, p => p.gitKey);
  // Only for projects git can't identify: two worktrees of one repo share a realpath prefix but are
  // distinct checkouts, and are already merged by their common .git above.
  unionByKey(uf, described, p => (p.gitKey ? null : p.realPath));
  const { referrers, appearancesOf } = linkSymlinkedProjects(uf, described);

  const result = new Map();
  for (const [groupId, slugs] of collectComponents(uf, described)) {
    if (slugs.length < 2) continue;

    const primarySlug = pickPrimary(slugs, bySlug, referrers);
    // Named after the project the group is built around, so the label stays stable no matter which
    // member the union-find happened to visit first.
    const groupLabel = path.basename(bySlug.get(primarySlug).path);
    const { parentOf, relOf } = computeNesting(slugs, bySlug, appearancesOf);

    for (const slug of slugs) {
      result.set(slug, {
        groupId,
        groupLabel,
        groupPrimary: slug === primarySlug,
        groupParentSlug: parentOf.get(slug) || null,
        groupRelPath: relOf.get(slug) || null
      });
    }
  }
  return result;
}

/**
 * Every project slug grouped with `slug`, including `slug` itself, ordered with the group's primary
 * first so a caller listing or searching across the group reports the hub before its worktrees.
 * Returns just `[slug]` when the project isn't in a group, so callers need no special case.
 */
function groupMemberSlugs(slug) {
  const projects = listProjectDirs();
  const groups = computeGroups(projects);
  const own = groups.get(slug);
  if (!own) return [slug];

  return projects
    .filter(p => groups.get(p.slug)?.groupId === own.groupId)
    .sort((a, b) => (groups.get(b.slug).groupPrimary ? 1 : 0) - (groups.get(a.slug).groupPrimary ? 1 : 0))
    .map(p => p.slug);
}

module.exports = { computeGroups, groupMemberSlugs };
