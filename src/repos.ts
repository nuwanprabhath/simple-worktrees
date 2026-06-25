import * as path from 'path';
import { API, Repository } from './gitApi';
import { Git } from './worktrees';

export interface RepoInfo {
  /** Stable repo identity (shared git-common-dir), used as the group-store key. */
  repoKey: string;
  /** A representative open repository — the main worktree when one is open. */
  repo: Repository;
  /** Filesystem root of the representative repository. */
  root: string;
  /** Display name of the repo (its main worktree's folder name). */
  name: string;
}

/**
 * A submodule's git dir lives under the superproject's `.git/modules/…`, so its
 * common-dir contains that segment. We use this to keep submodules out of the
 * worktree view (they'd otherwise show up as bogus extra repositories).
 */
function isSubmoduleCommonDir(commonDir: string): boolean {
  return commonDir.includes(`${path.sep}.git${path.sep}modules${path.sep}`);
}

/**
 * Collapse VS Code's open repositories down to the distinct underlying repos.
 *
 * VS Code tracks every open worktree as its own "repository" (and discovers
 * submodules as repositories too). Worktrees of one repo share a git-common-dir,
 * so we group by it and pick the main worktree as each group's representative.
 * Submodules are excluded — this view manages the project's own worktrees.
 */
export async function getUniqueRepos(api: API, git: Git): Promise<RepoInfo[]> {
  const groups = new Map<string, Repository[]>();
  for (const repo of api.repositories) {
    let key = repo.rootUri.fsPath;
    try {
      key = await git.commonDir(repo.rootUri.fsPath);
    } catch {
      // Fall back to the path itself; worst case it just isn't collapsed.
    }
    if (isSubmoduleCommonDir(key)) {
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(repo);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([repoKey, group]) => {
    // For a normal repo the common dir is `<main>/.git`; that main worktree is
    // both the preferred representative and the source of the display name.
    const mainPath = path.basename(repoKey) === '.git' ? path.dirname(repoKey) : undefined;
    const repo = (mainPath && group.find((r) => r.rootUri.fsPath === mainPath)) || group[0];
    return { repoKey, repo, root: repo.rootUri.fsPath, name: path.basename(mainPath ?? repo.rootUri.fsPath) };
  });
}
