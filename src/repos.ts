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
}

/**
 * Collapse VS Code's open repositories down to the distinct underlying repos.
 *
 * VS Code tracks every open worktree as its own "repository", but they share
 * one repo. We group by git-common-dir and pick the main worktree as each
 * group's representative.
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
    const group = groups.get(key) ?? [];
    group.push(repo);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([repoKey, group]) => {
    const mainPath = path.basename(repoKey) === '.git' ? path.dirname(repoKey) : undefined;
    const repo = (mainPath && group.find((r) => r.rootUri.fsPath === mainPath)) || group[0];
    return { repoKey, repo, root: repo.rootUri.fsPath };
  });
}
