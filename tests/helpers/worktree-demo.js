const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Builds a real on-disk fixture around a single main workspace repo, covering the three ways a
// related project directory shows up (straight from the worktree-grouping feature request):
//
//   workspace-demo/                     <- open THIS in an IDE to see it all
//     no-git-subproject/                   plain folder, no git — for users without git installed
//     no-git-subproject-symlink -> no-git-subproject         (same dir, two paths)
//     linked-repos/
//       independent-service -> ../../standalone-service      (symlink to a SEPARATE repo, like the
//                                                              real OmanTAX -> tms-backend case —
//                                                              related but NOT the same project)
//   workspace-demo-hotfix/              <- sibling: a git worktree of workspace-demo itself
//                                           (git worktrees can't nest inside their own repo's tree,
//                                           so this one has to sit next to it, not inside it)
//   standalone-service/                 <- sibling: the independent repo the symlink above targets
//
// workspace-demo / workspace-demo-hotfix are named so one is a hyphen-bounded prefix of the other —
// the exact pattern that exposed the decodeSlug greedy-shortest-match bug (see tests/slug.test.js).

function run(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function identity(dir) {
  run(['config', 'user.email', 'test@example.com'], dir);
  run(['config', 'user.name', 'test'], dir);
  run(['config', 'commit.gpgsign', 'false'], dir);
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  run(['init', '-q'], dir);
  identity(dir);
  fs.writeFileSync(path.join(dir, 'test.txt'), path.basename(dir) + '\n');
  run(['add', '.'], dir);
  run(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

/** Build the fixture under `parent` (caller owns cleanup). Returns the absolute path of each member. */
function buildWorktreeDemo(parent) {
  fs.rmSync(parent, { recursive: true, force: true });
  fs.mkdirSync(parent, { recursive: true });

  const workspaceDemo = initRepo(path.join(parent, 'workspace-demo'));

  // Non-git symlink alias, nested inside the workspace — auto-groups via realpath.
  const noGitSubproject = path.join(workspaceDemo, 'no-git-subproject');
  fs.mkdirSync(noGitSubproject, { recursive: true });
  fs.writeFileSync(path.join(noGitSubproject, 'test.txt'), 'no-git-subproject\n');
  const noGitSubprojectSymlink = path.join(workspaceDemo, 'no-git-subproject-symlink');
  fs.symlinkSync(noGitSubproject, noGitSubprojectSymlink, 'junction');

  // Independent repo, referenced from inside the workspace via a symlink — organizationally
  // related, and auto-grouped because workspace-demo links to it — but a different repo with its
  // own history, so it nests under the link rather than merging identities. Lives as a sibling of
  // workspace-demo, same as tms-backend sits outside n-ai1st-mo-workspace in the real example.
  const standaloneService = initRepo(path.join(parent, 'standalone-service'));
  const linkedRepos = path.join(workspaceDemo, 'linked-repos');
  fs.mkdirSync(linkedRepos, { recursive: true });
  fs.symlinkSync(standaloneService, path.join(linkedRepos, 'independent-service'), 'junction');

  // Git worktree of workspace-demo itself — auto-groups via the shared .git common dir. Must sit
  // next to workspace-demo, not inside it: git worktrees can't nest inside their own repo's tree.
  const workspaceDemoHotfix = path.join(parent, 'workspace-demo-hotfix');
  run(['worktree', 'add', '-q', '-b', 'hotfix', workspaceDemoHotfix], workspaceDemo);

  return { workspaceDemo, workspaceDemoHotfix, noGitSubproject, noGitSubprojectSymlink, standaloneService };
}

module.exports = { buildWorktreeDemo };
