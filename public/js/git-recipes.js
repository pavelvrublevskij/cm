// --- Git recipes ---
// Daily git commands for the project shell, grouped by task. Clicking one types it into the shell
// without a newline: the user reads it, edits the placeholders and presses Enter themselves.
// `danger: true` marks a command that rewrites history or discards work.
// Placeholders in <angle brackets> are substituted from live repo state where possible.

const GitRecipes = {
  CATEGORIES: [
    {
      name: 'Daily loop',
      items: [
        { cmd: 'git status -sb', explain: 'Short status plus how far ahead/behind the upstream you are.' },
        { cmd: 'git diff', explain: 'Unstaged changes — what you have edited but not yet staged.' },
        { cmd: 'git diff --staged', explain: 'Staged changes — exactly what the next commit will contain.' },
        { cmd: 'git add -p', explain: 'Stage hunk by hunk, so one file can be split across commits.' },
        { cmd: 'git commit -m "<message>"', explain: 'Commit what is staged.' },
        { cmd: 'git pull --ff-only', explain: 'Bring remote commits down, refusing to create a merge commit.' },
        { cmd: 'git push', explain: 'Send your commits to the upstream branch.' },
        { cmd: 'git push -u origin <branch>', explain: 'First push of a new branch — also sets its upstream.' }
      ]
    },
    {
      name: 'Branching',
      items: [
        { cmd: 'git switch <branch>', explain: 'Move to an existing branch.' },
        { cmd: 'git switch -c <branch>', explain: 'Create a branch from where you are and move to it.' },
        { cmd: 'git switch -', explain: 'Back to the branch you were on before.' },
        { cmd: 'git branch -vv', explain: 'Every local branch, its upstream, and its divergence.' },
        { cmd: 'git fetch --prune', explain: 'Refresh remote refs and drop ones deleted on the remote.' },
        { cmd: 'git branch -d <branch>', explain: 'Delete a branch that is already merged.' },
        { cmd: 'git branch -D <branch>', explain: 'Force-delete a branch even if it was never merged.', danger: true }
      ]
    },
    {
      name: 'Undo and recover',
      items: [
        { cmd: 'git restore <file>', explain: 'Throw away unstaged edits to a file.', danger: true },
        { cmd: 'git restore --staged <file>', explain: 'Unstage a file, keeping your edits.' },
        { cmd: 'git commit --amend', explain: 'Fold staged changes into the last commit, or reword it. Rewrites that commit.', danger: true },
        { cmd: 'git reset --soft HEAD~1', explain: 'Undo the last commit but keep its changes staged.' },
        { cmd: 'git reset --hard HEAD~1', explain: 'Undo the last commit and destroy its changes. No undo without reflog.', danger: true },
        { cmd: 'git revert <commit>', explain: 'Make a new commit that undoes an older one — safe on shared branches.' },
        { cmd: 'git reflog', explain: 'Every position HEAD has held. This is how you recover from a bad reset.' },
        { cmd: 'git reset --hard <sha-from-reflog>', explain: 'Jump back to a state you found in the reflog.', danger: true },
        { cmd: 'git clean -nd', explain: 'Dry run: list untracked files a clean would delete.' },
        { cmd: 'git clean -fd', explain: 'Delete untracked files and directories. Not recoverable.', danger: true }
      ]
    },
    {
      name: 'Stash',
      items: [
        { cmd: 'git stash push -m "<label>"', explain: 'Park your changes and return to a clean tree.' },
        { cmd: 'git stash push -u', explain: 'Also park untracked files.' },
        { cmd: 'git stash list', explain: 'Everything you have parked.' },
        { cmd: 'git stash pop', explain: 'Reapply the newest stash and drop it.' },
        { cmd: 'git stash apply stash@{0}', explain: 'Reapply a stash but keep it in the list.' },
        { cmd: 'git stash drop stash@{0}', explain: 'Delete a stash entry.', danger: true }
      ]
    },
    {
      name: 'Inspect',
      items: [
        { cmd: 'git log --oneline --graph --decorate -20', explain: 'Compact commit graph with branch and tag labels.' },
        { cmd: 'git log --oneline <base>..HEAD', explain: 'Just the commits your branch adds on top of a base branch.' },
        { cmd: 'git show <commit>', explain: 'Message plus full diff of one commit.' },
        { cmd: 'git diff <base>...HEAD', explain: 'The whole change your branch introduces — what a reviewer sees.' },
        { cmd: 'git blame <file>', explain: 'Which commit last touched each line.' },
        { cmd: 'git log -p --follow <file>', explain: 'A file\'s history with diffs, following renames.' },
        { cmd: 'git log -S"<text>" --oneline', explain: 'Find commits where an occurrence count of some text changed.' }
      ]
    },
    {
      name: 'Remotes',
      items: [
        { cmd: 'git remote -v', explain: 'Where fetch and push actually go.' },
        { cmd: 'git branch --set-upstream-to=origin/<branch>', explain: 'Point the current branch at a different upstream.' },
        { cmd: 'git fetch origin <branch>:<branch>', explain: 'Update a local branch you are not on, without switching.' },
        { cmd: 'git push origin --delete <branch>', explain: 'Delete a branch on the remote.', danger: true }
      ]
    },
    {
      name: 'Rewriting history',
      items: [
        { cmd: 'git rebase <base>', explain: 'Replay your commits on top of a newer base. Rewrites every commit it moves.', danger: true },
        { cmd: 'git rebase -i HEAD~<n>', explain: 'Reorder, squash, edit or drop your last n commits.', danger: true },
        { cmd: 'git rebase --continue', explain: 'Resume a rebase after resolving conflicts.' },
        { cmd: 'git rebase --abort', explain: 'Give up on a rebase and return to where you started.' },
        { cmd: 'git cherry-pick <commit>', explain: 'Copy one commit onto the current branch.' },
        { cmd: 'git push --force-with-lease', explain: 'Push a rewritten branch, refusing if someone else pushed meanwhile. Never use bare --force.', danger: true }
      ]
    }
  ],

  /** Fill <branch> and <base> from live repo state so a clicked recipe is usually runnable as-is. */
  substitute(cmd, info) {
    if (!info) return cmd;
    let out = cmd;
    if (info.branch && !info.detached) out = out.split('<branch>').join(info.branch);
    if (info.upstream) out = out.split('<base>').join(info.upstream);
    return out;
  }
};

window.GitRecipes = GitRecipes;
