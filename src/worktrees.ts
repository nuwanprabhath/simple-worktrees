import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const pexecFile = promisify(execFile);

export interface Worktree {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Commit the worktree currently points at. */
  head?: string;
  /** Short branch name, or undefined when detached. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** The first entry of `git worktree list` is the main worktree. */
  isMain: boolean;
}

export interface Branches {
  local: string[];
  remote: string[];
}

/** Upstream tracking state for a branch, as of the last fetch. */
export interface Tracking {
  ahead: number;
  behind: number;
  upstream: string;
  /** Upstream is configured but no longer exists (`[gone]`). */
  gone: boolean;
}

/** Thin wrapper around the git CLI scoped to worktree operations. */
export class Git {
  constructor(private readonly gitPath: string) {}

  private run(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return pexecFile(this.gitPath, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  }

  async listWorktrees(cwd: string): Promise<Worktree[]> {
    const { stdout } = await this.run(cwd, ['worktree', 'list', '--porcelain']);
    return parseWorktrees(stdout);
  }

  /**
   * Working-tree path of the superproject when `cwd` is a submodule, or an
   * empty string otherwise. Authoritative way to tell a submodule apart from a
   * normal repo / worktree (the common-dir layout varies, especially for
   * submodules inside linked worktrees).
   */
  async superproject(cwd: string): Promise<string> {
    const { stdout } = await this.run(cwd, ['rev-parse', '--show-superproject-working-tree']);
    return stdout.trim();
  }

  /**
   * Absolute path to the shared git directory. Every worktree of a repo
   * resolves to the same value, so it's a stable identity for "which repo".
   */
  async commonDir(cwd: string): Promise<string> {
    const { stdout } = await this.run(cwd, ['rev-parse', '--git-common-dir']);
    let dir = stdout.trim();
    if (!path.isAbsolute(dir)) {
      dir = path.resolve(cwd, dir);
    }
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  }

  async listBranches(cwd: string): Promise<Branches> {
    const [localOut, remoteOut] = await Promise.all([
      this.run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      this.run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
    ]);
    const local = localOut.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const remote = remoteOut.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((b) => b && !b.endsWith('/HEAD'));
    return { local, remote };
  }

  /**
   * Ahead/behind counts for every local branch with an upstream, keyed by short
   * branch name. Uses local refs only (no fetch), matching what VS Code's status
   * bar shows by default.
   */
  async branchTracking(cwd: string): Promise<Map<string, Tracking>> {
    const { stdout } = await this.run(cwd, [
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)',
      'refs/heads'
    ]);
    return parseTracking(stdout);
  }

  /** Add a worktree checking out an existing local branch. */
  async addExistingBranch(cwd: string, targetPath: string, branch: string): Promise<void> {
    await this.run(cwd, ['worktree', 'add', targetPath, branch]);
  }

  /** Add a worktree on a brand-new branch created from `startPoint` (default HEAD). */
  async addNewBranch(cwd: string, targetPath: string, branch: string, startPoint?: string): Promise<void> {
    const args = ['worktree', 'add', '-b', branch, targetPath];
    if (startPoint) {
      args.push(startPoint);
    }
    await this.run(cwd, args);
  }

  /** Add a worktree on a new local branch tracking a remote branch. */
  async addTrackingRemote(cwd: string, targetPath: string, localName: string, remoteRef: string): Promise<void> {
    await this.run(cwd, ['worktree', 'add', '--track', '-b', localName, targetPath, remoteRef]);
  }

  async removeWorktree(cwd: string, targetPath: string, force: boolean): Promise<void> {
    const args = ['worktree', 'remove', targetPath];
    if (force) {
      args.push('--force');
    }
    await this.run(cwd, args);
  }

  /** Pull the branch checked out in `cwd` from its upstream. */
  async pull(cwd: string): Promise<void> {
    await this.run(cwd, ['pull']);
  }

  /** Push the branch checked out in `cwd` to its upstream. */
  async push(cwd: string): Promise<void> {
    await this.run(cwd, ['push']);
  }
}

/** Parse the output of `git worktree list --porcelain`. */
export function parseWorktrees(stdout: string): Worktree[] {
  const blocks = stdout.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const result: Worktree[] = [];
  blocks.forEach((block, idx) => {
    const wt: Worktree = {
      path: '',
      detached: false,
      bare: false,
      locked: false,
      isMain: idx === 0
    };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        wt.path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        wt.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        wt.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        wt.detached = true;
      } else if (line === 'bare') {
        wt.bare = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        wt.locked = true;
      }
    }
    if (wt.path) {
      result.push(wt);
    }
  });
  return result;
}

/**
 * Parse the tab-separated `for-each-ref` output of
 * `%(refname:short)\t%(upstream:short)\t%(upstream:track)` into ahead/behind
 * counts keyed by short branch name. Branches without an upstream are omitted.
 */
export function parseTracking(stdout: string): Map<string, Tracking> {
  const map = new Map<string, Tracking>();
  for (const line of stdout.split('\n')) {
    const [name, upstream, track = ''] = line.split('\t');
    if (!name || !upstream) {
      continue;
    }
    if (track.includes('gone')) {
      map.set(name, { ahead: 0, behind: 0, upstream, gone: true });
      continue;
    }
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    map.set(name, {
      ahead: ahead ? parseInt(ahead[1], 10) : 0,
      behind: behind ? parseInt(behind[1], 10) : 0,
      upstream,
      gone: false
    });
  }
  return map;
}
