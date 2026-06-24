import * as path from 'path';
import * as vscode from 'vscode';
import { API } from './gitApi';
import { GroupStore } from './groupStore';
import { getUniqueRepos, RepoInfo } from './repos';
import { Git, Tracking, Worktree } from './worktrees';

/** A repository section, shown only when more than one distinct repo is open. */
export class RepoTreeItem extends vscode.TreeItem {
  readonly kind = 'repo';
  constructor(public readonly repoKey: string, root: string) {
    super(path.basename(root), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `repo:${repoKey}`;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'repo';
    this.resourceUri = vscode.Uri.file(root);
  }
}

/** A user-defined worktree group. */
export class GroupTreeItem extends vscode.TreeItem {
  readonly kind = 'group';
  constructor(
    public readonly repoKey: string,
    public readonly groupId: string,
    name: string,
    count: number,
    collapsed: boolean
  ) {
    super(
      name,
      collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
    );
    this.id = `group:${repoKey}:${groupId}`;
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'group';
  }
}

/** Branch name plus ahead/behind counts, e.g. `dev/1.0.10  95↓ 0↑`. */
function branchDescription(worktree: Worktree, tracking?: Tracking): string {
  let description = worktree.detached
    ? `(detached ${worktree.head?.slice(0, 7) ?? ''})`
    : worktree.branch ?? '';
  if (tracking) {
    // Mirror VS Code's status bar: behind ↓ then ahead ↑.
    description += tracking.gone ? '  ↓gone' : `  ${tracking.behind}↓ ${tracking.ahead}↑`;
  }
  return description;
}

/**
 * A summary header pinned to the top of the view, naming the worktree that is
 * open in this window so it's obvious at a glance which one you're in.
 */
export class CurrentTreeItem extends vscode.TreeItem {
  readonly kind = 'current';
  constructor(public readonly worktree: Worktree, public readonly tracking?: Tracking) {
    const name = path.basename(worktree.path);
    super(`Current: ${name}`, vscode.TreeItemCollapsibleState.None);
    this.id = `current:${worktree.path}`;
    this.description = branchDescription(worktree, tracking);
    // No icon on the summary header — it reads as a banner, not a worktree row.
    this.contextValue = 'current';
    this.tooltip = new vscode.MarkdownString(
      [`**${name}** — current worktree`, `Path: \`${worktree.path}\``].join('\n\n')
    );
  }
}

/** A single worktree row. */
export class WorktreeNode extends vscode.TreeItem {
  readonly kind = 'worktree';
  constructor(
    public readonly worktree: Worktree,
    public readonly repoKey: string,
    public readonly grouped: boolean,
    isCurrent: boolean,
    public readonly tracking?: Tracking
  ) {
    const name = path.basename(worktree.path);
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = `worktree:${repoKey}:${worktree.path}`;
    this.description = branchDescription(worktree, tracking);

    const lines = [
      `**${name}**${worktree.isMain ? '  ·  _main worktree_' : ''}`,
      worktree.branch ? `Branch: \`${worktree.branch}\`` : `Detached at \`${worktree.head?.slice(0, 7) ?? '?'}\``,
      `Path: \`${worktree.path}\``
    ];
    if (tracking) {
      lines.push(`Upstream: \`${tracking.upstream}\``);
      lines.push(tracking.gone ? '⚠️ Upstream is gone' : `${tracking.behind} behind · ${tracking.ahead} ahead`);
    }
    if (worktree.locked) {
      lines.push('🔒 Locked');
    }
    if (isCurrent) {
      lines.push('_Currently open in this window_');
    }
    this.tooltip = new vscode.MarkdownString(lines.join('\n\n'));

    this.iconPath = new vscode.ThemeIcon(
      isCurrent ? 'check' : worktree.isMain ? 'repo' : 'git-branch'
    );
    this.resourceUri = vscode.Uri.file(worktree.path);
    // Context value encodes main-ness, grouped-ness and whether there is
    // anything to pull/push, so menus can target worktrees precisely (see the
    // package.json `when` clauses). Tokens are colon-delimited, e.g.
    // `worktree:main:ungrouped:pull:push`.
    const canPull = !!tracking && !tracking.gone && tracking.behind > 0;
    const canPush = !!tracking && !tracking.gone && tracking.ahead > 0;
    this.contextValue =
      `worktree:${worktree.isMain ? 'main:' : ''}${grouped ? 'grouped' : 'ungrouped'}` +
      `${canPull ? ':pull' : ''}${canPush ? ':push' : ''}`;
    this.command = {
      command: 'simpleWorktrees.open',
      title: 'Open Worktree',
      arguments: [this]
    };
  }
}

export type TreeNode = CurrentTreeItem | RepoTreeItem | GroupTreeItem | WorktreeNode;

interface RepoView {
  groupNodes: GroupTreeItem[];
  ungrouped: WorktreeNode[];
  childrenByGroup: Map<string, WorktreeNode[]>;
}

export class WorktreesTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>, vscode.Disposable
{
  // Must match the view id, lowercased, per the TreeDragAndDropController contract.
  private static readonly MIME = 'application/vnd.code.tree.simpleworktreesview';
  readonly dragMimeTypes = [WorktreesTreeProvider.MIME];
  readonly dropMimeTypes = [WorktreesTreeProvider.MIME];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  // Snapshot computed at the root level and read by child queries.
  private repos: RepoInfo[] = [];
  private byRepo = new Map<string, RepoView>();
  private current?: { worktree: Worktree; tracking?: Tracking };

  constructor(
    private readonly api: API,
    private readonly git: Git,
    private readonly store: GroupStore
  ) {
    this.disposables.push(this.store.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      await this.computeSnapshot();
      if (this.repos.length === 0) {
        return [];
      }
      const base =
        this.repos.length === 1
          ? this.rootForRepo(this.repos[0].repoKey)
          : this.repos.map((r) => new RepoTreeItem(r.repoKey, r.root));
      // Pin a bold summary of the current worktree to the very top.
      return this.current ? [new CurrentTreeItem(this.current.worktree, this.current.tracking), ...base] : base;
    }
    if (element.kind === 'repo') {
      return this.rootForRepo(element.repoKey);
    }
    if (element.kind === 'group') {
      return this.byRepo.get(element.repoKey)?.childrenByGroup.get(element.groupId) ?? [];
    }
    return [];
  }

  /** Top-level rows for a repo: ungrouped worktrees first, then groups. */
  private rootForRepo(repoKey: string): TreeNode[] {
    const view = this.byRepo.get(repoKey);
    if (!view) {
      return [];
    }
    return [...view.ungrouped, ...view.groupNodes];
  }

  private async computeSnapshot(): Promise<void> {
    this.repos = await getUniqueRepos(this.api, this.git);
    this.byRepo = new Map();
    this.current = undefined;
    const openPaths = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));

    for (const { repoKey, root } of this.repos) {
      let worktrees: Worktree[] = [];
      try {
        worktrees = await this.git.listWorktrees(root);
      } catch {
        // Not worktree-capable / git error — leave empty.
      }
      let tracking = new Map<string, Tracking>();
      try {
        tracking = await this.git.branchTracking(root);
      } catch {
        // Counts are best-effort.
      }

      worktrees.sort((a, b) => {
        if (a.isMain !== b.isMain) {
          return a.isMain ? -1 : 1;
        }
        return path.basename(a.path).localeCompare(path.basename(b.path));
      });

      const childrenByGroup = new Map<string, WorktreeNode[]>();
      const ungrouped: WorktreeNode[] = [];
      for (const wt of worktrees) {
        const groupId = this.store.groupOf(repoKey, wt.path);
        const trackingInfo = wt.branch ? tracking.get(wt.branch) : undefined;
        const isCurrent = openPaths.has(wt.path);
        if (isCurrent && !this.current) {
          this.current = { worktree: wt, tracking: trackingInfo };
        }
        const node = new WorktreeNode(wt, repoKey, !!groupId, isCurrent, trackingInfo);
        if (groupId) {
          const list = childrenByGroup.get(groupId) ?? [];
          list.push(node);
          childrenByGroup.set(groupId, list);
        } else {
          ungrouped.push(node);
        }
      }

      const groupNodes = this.store
        .groupsFor(repoKey)
        .map(
          (g) =>
            new GroupTreeItem(
              repoKey,
              g.id,
              g.name,
              childrenByGroup.get(g.id)?.length ?? 0,
              this.store.isCollapsed(repoKey, g.id)
            )
        );

      this.byRepo.set(repoKey, { groupNodes, ungrouped, childrenByGroup });
    }
  }

  // --- TreeDragAndDropController ---

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    const draggable = source.filter((n) => n.kind === 'worktree' || n.kind === 'group');
    if (draggable.length) {
      dataTransfer.set(WorktreesTreeProvider.MIME, new vscode.DataTransferItem(draggable));
    }
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(WorktreesTreeProvider.MIME);
    if (!item) {
      return;
    }
    const source = item.value as TreeNode[];

    // Reordering a group onto another group of the same repo.
    const draggedGroup = source.find((n): n is GroupTreeItem => n.kind === 'group');
    if (draggedGroup) {
      if (target?.kind === 'group' && target.repoKey === draggedGroup.repoKey) {
        await this.store.reorderGroup(draggedGroup.repoKey, draggedGroup.groupId, target.groupId);
      }
      return;
    }

    // Moving worktrees into / out of a group.
    const worktrees = source.filter((n): n is WorktreeNode => n.kind === 'worktree');
    if (!worktrees.length) {
      return;
    }

    let repoKey: string;
    let groupId: string | undefined;
    if (target?.kind === 'group') {
      repoKey = target.repoKey;
      groupId = target.groupId;
    } else if (target?.kind === 'worktree') {
      repoKey = target.repoKey;
      groupId = this.store.groupOf(target.repoKey, target.worktree.path);
    } else if (target?.kind === 'repo') {
      repoKey = target.repoKey;
      groupId = undefined; // dropping on the repo header ungroups
    } else {
      repoKey = worktrees[0].repoKey;
      groupId = undefined; // dropping on empty space ungroups
    }

    const paths = worktrees.filter((w) => w.repoKey === repoKey).map((w) => w.worktree.path);
    if (paths.length) {
      await this.store.assign(repoKey, paths, groupId);
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
