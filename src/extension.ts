import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { API, GitExtension } from './gitApi';
import { GroupStore } from './groupStore';
import { getUniqueRepos, RepoInfo } from './repos';
import { GroupTreeItem, TreeNode, WorktreeNode, WorktreesTreeProvider } from './treeProvider';
import { Branches, Git } from './worktrees';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) {
    void vscode.window.showErrorMessage('Simple Worktrees: the built-in Git extension is not available.');
    return;
  }
  const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  const api = exports.getAPI(1);
  const git = new Git(api.git.path);
  const store = new GroupStore(context.globalState);

  const provider = new WorktreesTreeProvider(api, git, store);
  const view = vscode.window.createTreeView('simpleWorktreesView', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    canSelectMany: true,
    showCollapseAll: true
  });
  context.subscriptions.push(view, provider);

  // Persist each group's collapsed/expanded state (per repo, in global state)
  // so it carries across windows when you open another worktree.
  context.subscriptions.push(
    view.onDidCollapseElement((e) => {
      if (e.element.kind === 'group') {
        void store.setCollapsed(e.element.repoKey, e.element.groupId, true);
      }
    }),
    view.onDidExpandElement((e) => {
      if (e.element.kind === 'group') {
        void store.setCollapsed(e.element.repoKey, e.element.groupId, false);
      }
    })
  );

  // Keep the list fresh when repositories appear/disappear or git initialises.
  context.subscriptions.push(
    api.onDidOpenRepository(() => provider.refresh()),
    api.onDidCloseRepository(() => provider.refresh())
  );
  if (api.state !== 'initialized') {
    context.subscriptions.push(api.onDidChangeState(() => provider.refresh()));
  }

  // Periodically poll git so externally-made changes (a new worktree, a branch
  // switch, fresh commit counts) show up without a manual refresh. Only runs
  // while the view is visible, to avoid pointless background git calls.
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const startTimer = () => {
    stopTimer();
    const seconds = vscode.workspace.getConfiguration('simpleWorktrees').get<number>('refreshInterval', 10);
    if (seconds > 0 && view.visible) {
      timer = setInterval(() => provider.refresh(), seconds * 1000);
    }
  };
  context.subscriptions.push(
    view.onDidChangeVisibility((e) => {
      if (e.visible) {
        provider.refresh();
        startTimer();
      } else {
        stopTimer();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('simpleWorktrees.refreshInterval')) {
        startTimer();
      }
    }),
    { dispose: stopTimer }
  );
  startTimer();

  const register = (command: string, callback: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));

  register('simpleWorktrees.refresh', () => provider.refresh());

  register('simpleWorktrees.open', (node?: WorktreeNode) => openWorktree(node, false));
  register('simpleWorktrees.openNewWindow', (node?: WorktreeNode) => openWorktree(node, true));

  register('simpleWorktrees.copyPath', async (node?: WorktreeNode) => {
    if (!node) {
      return;
    }
    await vscode.env.clipboard.writeText(node.worktree.path);
    void vscode.window.showInformationMessage(`Copied: ${node.worktree.path}`);
  });

  register('simpleWorktrees.remove', (node?: WorktreeNode) => removeWorktree(api, git, provider, node));

  register('simpleWorktrees.create', () => createWorktree(api, git, provider));

  // --- Group commands ---

  const selectedWorktrees = (node?: WorktreeNode, nodes?: TreeNode[]): WorktreeNode[] => {
    const list = nodes?.length ? nodes : node ? [node] : [];
    return list.filter((n): n is WorktreeNode => !!n && n.kind === 'worktree');
  };

  register('simpleWorktrees.createGroup', async () => {
    const repo = await pickRepository(api, git);
    if (!repo) {
      return;
    }
    const name = await promptGroupName();
    if (name) {
      await store.createGroup(repo.repoKey, name);
    }
  });

  register('simpleWorktrees.renameGroup', async (node?: GroupTreeItem) => {
    if (node?.kind !== 'group') {
      return;
    }
    const current = store.getGroup(node.repoKey, node.groupId);
    const name = await promptGroupName(current?.name);
    if (name) {
      await store.renameGroup(node.repoKey, node.groupId, name);
    }
  });

  register('simpleWorktrees.deleteGroup', async (node?: GroupTreeItem) => {
    if (node?.kind !== 'group') {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete group '${node.label}'? Worktrees in it move back to ungrouped (nothing is removed from disk).`,
      { modal: true },
      'Delete'
    );
    if (confirm === 'Delete') {
      await store.deleteGroup(node.repoKey, node.groupId);
    }
  });

  register('simpleWorktrees.moveGroupUp', (node?: GroupTreeItem) => {
    if (node?.kind === 'group') {
      void store.moveGroup(node.repoKey, node.groupId, -1);
    }
  });
  register('simpleWorktrees.moveGroupDown', (node?: GroupTreeItem) => {
    if (node?.kind === 'group') {
      void store.moveGroup(node.repoKey, node.groupId, 1);
    }
  });

  register('simpleWorktrees.addToGroup', async (node?: WorktreeNode, nodes?: TreeNode[]) => {
    const worktrees = selectedWorktrees(node, nodes);
    if (!worktrees.length) {
      return;
    }
    // All selected worktrees must belong to one repo to share a group.
    const repoKey = worktrees[0].repoKey;
    const paths = worktrees.filter((w) => w.repoKey === repoKey).map((w) => w.worktree.path);

    const groups = store.groupsFor(repoKey);
    const items: (vscode.QuickPickItem & { groupId?: string; create?: boolean })[] = [
      { label: '$(new-folder) New group…', create: true, alwaysShow: true },
      ...(groups.length ? [{ label: 'Groups', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...groups.map((g) => ({ label: `$(folder) ${g.name}`, groupId: g.id }))
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: paths.length > 1 ? `Add ${paths.length} worktrees to group` : 'Add worktree to group',
      placeHolder: 'Choose a group, or create a new one'
    });
    if (!pick) {
      return;
    }
    let groupId = pick.groupId;
    if (pick.create) {
      const name = await promptGroupName();
      if (!name) {
        return;
      }
      groupId = await store.createGroup(repoKey, name);
    }
    if (groupId) {
      await store.assign(repoKey, paths, groupId);
    }
  });

  register('simpleWorktrees.removeFromGroup', async (node?: WorktreeNode, nodes?: TreeNode[]) => {
    const worktrees = selectedWorktrees(node, nodes);
    for (const repoKey of new Set(worktrees.map((w) => w.repoKey))) {
      const paths = worktrees.filter((w) => w.repoKey === repoKey).map((w) => w.worktree.path);
      await store.assign(repoKey, paths, undefined);
    }
  });
}

/** Prompt for a group name; rejects blanks. */
async function promptGroupName(value?: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: value ? 'Rename group' : 'New group',
    prompt: 'Group name',
    value,
    validateInput: (v) => (v.trim() ? undefined : 'A name is required.')
  });
  return name?.trim() || undefined;
}

export function deactivate(): void {
  // Nothing to clean up beyond the disposables registered in `activate`.
}

function openWorktree(node: WorktreeNode | undefined, forceNewWindow: boolean): void {
  if (!node) {
    return;
  }
  void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.path), {
    forceNewWindow
  });
}

/**
 * Pick a repository, prompting only when genuinely distinct repos are open.
 *
 * VS Code tracks each open worktree as its own "repository", but they share one
 * underlying repo and adding a worktree from any of them is equivalent. We
 * collapse them by shared git-common-dir so the user isn't asked to choose
 * between identical options (and isn't prompted at all when there's just one).
 */
async function pickRepository(api: API, git: Git): Promise<RepoInfo | undefined> {
  const unique = await getUniqueRepos(api, git);
  if (unique.length === 0) {
    void vscode.window.showWarningMessage('Simple Worktrees: no git repository found.');
    return undefined;
  }
  if (unique.length === 1) {
    return unique[0];
  }
  const picked = await vscode.window.showQuickPick(
    unique.map((info) => ({ label: path.basename(info.root), description: info.root, info })),
    { title: 'Select repository', placeHolder: 'Which repository should the worktree belong to?' }
  );
  return picked?.info;
}

type BranchPick = vscode.QuickPickItem & {
  action?: 'new' | 'local' | 'remote' | 'head';
  ref?: string;
};

/**
 * Ask which branch/commit a new branch should be based on. Resolves to
 * `{ ref }` (ref `undefined` means current HEAD), or `undefined` if cancelled.
 */
async function pickStartPoint(branches: Branches): Promise<{ ref?: string } | undefined> {
  const items: BranchPick[] = [
    {
      label: '$(git-commit) Current HEAD',
      detail: 'Base the new branch on the current checkout',
      action: 'head',
      alwaysShow: true
    }
  ];
  if (branches.local.length) {
    items.push({ label: 'Local branches', kind: vscode.QuickPickItemKind.Separator });
    for (const b of branches.local) {
      items.push({ label: b, action: 'local', ref: b });
    }
  }
  if (branches.remote.length) {
    items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
    for (const b of branches.remote) {
      items.push({ label: `$(cloud) ${b}`, action: 'remote', ref: b });
    }
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Base branch',
    placeHolder: 'Create the new branch from…'
  });
  if (!pick || !pick.action) {
    return undefined;
  }
  return { ref: pick.action === 'head' ? undefined : pick.ref };
}

async function createWorktree(api: API, git: Git, provider: WorktreesTreeProvider): Promise<void> {
  const repo = await pickRepository(api, git);
  if (!repo) {
    return;
  }
  const repoRoot = repo.root;

  let worktrees;
  try {
    worktrees = await git.listWorktrees(repoRoot);
  } catch (err) {
    void vscode.window.showErrorMessage(`Simple Worktrees: failed to read worktrees. ${errMessage(err)}`);
    return;
  }

  // Worktrees are created alongside the main checkout, mirroring the
  // `<repo>.worktrees/<name>` layout (e.g. paratoo-fdcp.worktrees/species-list).
  const mainPath = (worktrees.find((w) => w.isMain) ?? worktrees[0]).path;
  const parentDir = `${mainPath}.worktrees`;

  const name = await vscode.window.showInputBox({
    title: 'New Worktree',
    prompt: `Folder name — created in ${parentDir}`,
    placeHolder: 'e.g. species-list',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'A name is required.';
      }
      if (/[\\/]/.test(trimmed)) {
        return 'Name cannot contain slashes.';
      }
      if (fs.existsSync(path.join(parentDir, trimmed))) {
        return 'A folder with this name already exists.';
      }
      return undefined;
    }
  });
  if (!name) {
    return;
  }
  const worktreeName = name.trim();
  const targetPath = path.join(parentDir, worktreeName);

  let branches;
  try {
    branches = await git.listBranches(repoRoot);
  } catch (err) {
    void vscode.window.showErrorMessage(`Simple Worktrees: failed to read branches. ${errMessage(err)}`);
    return;
  }

  const checkedOut = new Set(worktrees.map((w) => w.branch).filter((b): b is string => !!b));
  const localSet = new Set(branches.local);

  const items: BranchPick[] = [
    { label: '$(add) Create new branch…', detail: 'Choose a base branch in the next step', action: 'new', alwaysShow: true }
  ];
  if (branches.local.length) {
    items.push({ label: 'Local branches', kind: vscode.QuickPickItemKind.Separator });
    for (const b of branches.local) {
      items.push({
        label: b,
        description: checkedOut.has(b) ? '$(check) already checked out' : undefined,
        action: 'local',
        ref: b
      });
    }
  }
  if (branches.remote.length) {
    items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
    for (const b of branches.remote) {
      items.push({ label: `$(cloud) ${b}`, action: 'remote', ref: b });
    }
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: `New Worktree — ${worktreeName}`,
    placeHolder: 'Select a branch to check out, or create a new one'
  });
  if (!pick || !pick.action) {
    return;
  }

  let branchToCreate: string | undefined;
  let startPoint: string | undefined;
  if (pick.action === 'new') {
    // Base branch first, then the new branch name — mirrors VS Code's own
    // "Create Branch From…" flow so the steps feel familiar.
    const base = await pickStartPoint(branches);
    if (!base) {
      return;
    }
    startPoint = base.ref;

    branchToCreate = await vscode.window.showInputBox({
      title: 'New branch name',
      prompt: 'Name for the new branch',
      value: worktreeName,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'A branch name is required.';
        }
        if (localSet.has(trimmed)) {
          return 'A local branch with this name already exists.';
        }
        return undefined;
      }
    });
    if (!branchToCreate) {
      return;
    }
    branchToCreate = branchToCreate.trim();
  } else if (pick.action === 'local' && checkedOut.has(pick.ref!)) {
    void vscode.window.showErrorMessage(
      `Branch '${pick.ref}' is already checked out in another worktree. Git only allows a branch in one worktree at a time.`
    );
    return;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree '${worktreeName}'…` },
      async () => {
        if (pick.action === 'new') {
          await git.addNewBranch(repoRoot, targetPath, branchToCreate!, startPoint);
        } else if (pick.action === 'local') {
          await git.addExistingBranch(repoRoot, targetPath, pick.ref!);
        } else {
          // Remote branch: reuse a matching local branch if one exists,
          // otherwise create a local tracking branch.
          const localName = pick.ref!.split('/').slice(1).join('/');
          if (localName && localSet.has(localName)) {
            await git.addExistingBranch(repoRoot, targetPath, localName);
          } else {
            await git.addTrackingRemote(repoRoot, targetPath, localName || worktreeName, pick.ref!);
          }
        }
      }
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Simple Worktrees: failed to create worktree. ${errMessage(err)}`);
    return;
  }

  provider.refresh();

  const choice = await vscode.window.showInformationMessage(
    `Worktree '${worktreeName}' created.`,
    'Open',
    'Open in New Window'
  );
  if (choice === 'Open') {
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetPath), { forceNewWindow: false });
  } else if (choice === 'Open in New Window') {
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(targetPath), { forceNewWindow: true });
  }
}

async function removeWorktree(
  api: API,
  git: Git,
  provider: WorktreesTreeProvider,
  node: WorktreeNode | undefined
): Promise<void> {
  if (!node || node.worktree.isMain) {
    return;
  }
  const repo = api.repositories[0];
  if (!repo) {
    return;
  }
  const name = path.basename(node.worktree.path);
  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree '${name}'?`,
    { modal: true, detail: node.worktree.path },
    'Remove'
  );
  if (confirm !== 'Remove') {
    return;
  }

  try {
    await git.removeWorktree(repo.rootUri.fsPath, node.worktree.path, false);
  } catch (err) {
    // Likely has uncommitted/untracked changes — offer a forced removal.
    const force = await vscode.window.showWarningMessage(
      `Could not remove '${name}' (it may contain changes). Force remove?`,
      { modal: true, detail: errMessage(err) },
      'Force Remove'
    );
    if (force !== 'Force Remove') {
      return;
    }
    try {
      await git.removeWorktree(repo.rootUri.fsPath, node.worktree.path, true);
    } catch (err2) {
      void vscode.window.showErrorMessage(`Simple Worktrees: failed to remove worktree. ${errMessage(err2)}`);
      return;
    }
  }
  provider.refresh();
}

function errMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as { stderr?: string; message?: string };
    return (anyErr.stderr || anyErr.message || String(err)).trim();
  }
  return String(err);
}
