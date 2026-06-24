import { API, Repository } from '../gitApi';
import { Git, Tracking, Worktree } from '../worktrees';

/** In-memory vscode.Memento. */
export class MemoryMemento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      // Mimic real Memento behavior: values round-trip through JSON.
      this.store.set(key, JSON.parse(JSON.stringify(value)));
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

export function makeWorktree(partial: Partial<Worktree> & { path: string }): Worktree {
  return {
    head: undefined,
    branch: undefined,
    detached: false,
    bare: false,
    locked: false,
    isMain: false,
    ...partial
  };
}

export function makeRepo(root: string): Repository {
  return { rootUri: { fsPath: root } } as unknown as Repository;
}

export function makeApi(roots: string[]): API {
  return {
    state: 'initialized',
    git: { path: 'git' },
    repositories: roots.map(makeRepo)
  } as unknown as API;
}

export interface RepoFixture {
  /** Value `commonDir` should return for this repo's worktree roots. */
  common: string;
  worktrees: Worktree[];
  tracking?: Map<string, Tracking>;
}

/**
 * A fake `Git` that serves canned data per repo root, so the tree provider and
 * repo-dedup logic can be tested without spawning git. `commonDir` rejects for
 * paths in `failCommonDir` to exercise the fallback path.
 */
export function makeGit(
  fixtures: Record<string, RepoFixture>,
  failCommonDir: string[] = []
): Git {
  const find = (cwd: string): RepoFixture | undefined => fixtures[cwd];
  return {
    async listWorktrees(cwd: string) {
      return find(cwd)?.worktrees ?? [];
    },
    async branchTracking(cwd: string) {
      return find(cwd)?.tracking ?? new Map<string, Tracking>();
    },
    async commonDir(cwd: string) {
      if (failCommonDir.includes(cwd)) {
        throw new Error('not a git repo');
      }
      const fixture = find(cwd);
      if (!fixture) {
        throw new Error(`no fixture for ${cwd}`);
      }
      return fixture.common;
    }
  } as unknown as Git;
}
