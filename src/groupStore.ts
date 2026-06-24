import * as vscode from 'vscode';

const STATE_KEY = 'simpleWorktrees.state';

export interface GroupDef {
  id: string;
  name: string;
}

interface RepoGroupState {
  groups: GroupDef[];
  /** worktree path → group id */
  assignments: Record<string, string>;
  /** Ids of groups the user has collapsed (default is expanded). */
  collapsed?: string[];
}

/**
 * Persists worktree groups and worktree→group assignments in global state,
 * scoped per repository (keyed by the repo's shared git-common-dir so the same
 * groups show up from any worktree/window of that repo). Array order of
 * `groups` is the display order. Assignments are keyed by absolute worktree
 * path.
 */
export class GroupStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly state: Record<string, RepoGroupState>;

  constructor(private readonly memento: vscode.Memento) {
    this.state = memento.get<Record<string, RepoGroupState>>(STATE_KEY) ?? {};
  }

  groupsFor(repoKey: string): readonly GroupDef[] {
    return this.repoState(repoKey).groups;
  }

  getGroup(repoKey: string, id: string): GroupDef | undefined {
    return this.repoState(repoKey).groups.find((g) => g.id === id);
  }

  /** Group a worktree belongs to, or undefined when ungrouped. */
  groupOf(repoKey: string, worktreePath: string): string | undefined {
    const state = this.repoState(repoKey);
    const id = state.assignments[worktreePath];
    return id && state.groups.some((g) => g.id === id) ? id : undefined;
  }

  async createGroup(repoKey: string, name: string): Promise<string> {
    const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.repoState(repoKey).groups.push({ id, name });
    await this.save();
    return id;
  }

  async renameGroup(repoKey: string, id: string, name: string): Promise<void> {
    const group = this.getGroup(repoKey, id);
    if (!group) {
      return;
    }
    group.name = name;
    await this.save();
  }

  async deleteGroup(repoKey: string, id: string): Promise<void> {
    const state = this.repoState(repoKey);
    state.groups = state.groups.filter((g) => g.id !== id);
    for (const [worktreePath, groupId] of Object.entries(state.assignments)) {
      if (groupId === id) {
        delete state.assignments[worktreePath];
      }
    }
    await this.save();
  }

  async moveGroup(repoKey: string, id: string, delta: -1 | 1): Promise<void> {
    const groups = this.repoState(repoKey).groups;
    const index = groups.findIndex((g) => g.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= groups.length) {
      return;
    }
    [groups[index], groups[target]] = [groups[target], groups[index]];
    await this.save();
  }

  /** Move `dragId` to the slot currently held by `targetId` (drag & drop reorder). */
  async reorderGroup(repoKey: string, dragId: string, targetId: string): Promise<void> {
    if (dragId === targetId) {
      return;
    }
    const groups = this.repoState(repoKey).groups;
    const from = groups.findIndex((g) => g.id === dragId);
    if (from < 0) {
      return;
    }
    const [dragged] = groups.splice(from, 1);
    const to = groups.findIndex((g) => g.id === targetId);
    groups.splice(to < 0 ? from : to, 0, dragged);
    await this.save();
  }

  /** Assign worktrees to a group; `undefined` ungroups them. */
  async assign(repoKey: string, worktreePaths: string[], groupId: string | undefined): Promise<void> {
    const assignments = this.repoState(repoKey).assignments;
    for (const worktreePath of worktreePaths) {
      if (groupId) {
        assignments[worktreePath] = groupId;
      } else {
        delete assignments[worktreePath];
      }
    }
    await this.save();
  }

  isCollapsed(repoKey: string, groupId: string): boolean {
    return this.repoState(repoKey).collapsed?.includes(groupId) ?? false;
  }

  /**
   * Remember a group's collapsed/expanded state. Persisted to global state so
   * it carries across windows/worktrees, but saved *silently* (no onDidChange):
   * the tree already shows the new state, so a refresh would only cause flicker.
   */
  async setCollapsed(repoKey: string, groupId: string, collapsed: boolean): Promise<void> {
    const state = this.repoState(repoKey);
    const set = new Set(state.collapsed ?? []);
    if (collapsed) {
      set.add(groupId);
    } else {
      set.delete(groupId);
    }
    state.collapsed = [...set];
    await this.memento.update(STATE_KEY, this.state);
  }

  private repoState(repoKey: string): RepoGroupState {
    let state = this.state[repoKey];
    if (!state) {
      state = { groups: [], assignments: {} };
      this.state[repoKey] = state;
    }
    return state;
  }

  private async save(): Promise<void> {
    await this.memento.update(STATE_KEY, this.state);
    this._onDidChange.fire();
  }
}
