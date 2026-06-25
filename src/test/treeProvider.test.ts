import * as assert from 'assert';
import { GroupStore } from '../groupStore';
import { GroupTreeItem, RepoTreeItem, TreeNode, WorktreeNode, WorktreesTreeProvider } from '../treeProvider';
import { Tracking } from '../worktrees';
import { makeApi, makeGit, makeWorktree, MemoryMemento } from './helpers';
// Same module instance the provider sees (hook redirects 'vscode' here).
import { DataTransfer, workspace as mockWorkspace } from './mocks/vscode';

const KEY = '/repo/.git';

function tracking(entries: Record<string, Tracking>): Map<string, Tracking> {
  return new Map(Object.entries(entries));
}

function singleRepoProvider(): { provider: WorktreesTreeProvider; store: GroupStore } {
  const worktrees = [
    makeWorktree({ path: '/repo', branch: 'main', isMain: true, head: 'aaaaaaa' }),
    makeWorktree({ path: '/repo.worktrees/feature', branch: 'feature/x', head: 'bbbbbbb' })
  ];
  const git = makeGit({
    '/repo': {
      common: KEY,
      worktrees,
      tracking: tracking({
        main: { ahead: 0, behind: 0, upstream: 'origin/main', gone: false },
        'feature/x': { ahead: 2, behind: 5, upstream: 'origin/feature/x', gone: false }
      })
    }
  });
  const store = new GroupStore(new MemoryMemento() as never);
  const provider = new WorktreesTreeProvider(makeApi(['/repo']), git, store);
  return { provider, store };
}

const groups = (nodes: TreeNode[]) => nodes.filter((n): n is GroupTreeItem => n.kind === 'group');
const worktrees = (nodes: TreeNode[]) => nodes.filter((n): n is WorktreeNode => n.kind === 'worktree');

function labelText(n: TreeNode): string {
  const l = (n as { label: string | { label: string } }).label;
  return typeof l === 'string' ? l : l.label;
}
function boldRanges(n: TreeNode): [number, number][] | undefined {
  const l = (n as { label: string | { highlights?: [number, number][] } }).label;
  return typeof l === 'string' ? undefined : l.highlights;
}

describe('WorktreesTreeProvider', () => {
  afterEach(() => {
    mockWorkspace.workspaceFolders = undefined;
  });

  it('lists worktrees with the main one first and branch + counts in the description', async () => {
    const { provider } = singleRepoProvider();
    const roots = await provider.getChildren();

    assert.deepStrictEqual(
      worktrees(roots).map((n) => n.label),
      ['repo', 'feature']
    );
    const [main, feature] = worktrees(roots);
    // main is up to date → no pull/push tokens.
    assert.strictEqual(main.contextValue, 'worktree:main:ungrouped');
    // feature is behind 5 and ahead 2 → both pull and push are offered.
    assert.strictEqual(feature.contextValue, 'worktree:ungrouped:pull:push');
    assert.strictEqual(feature.description, 'feature/x  5↓ 2↑');
  });

  it('encodes pull/push capability from the tracking counts', async () => {
    const git = makeGit({
      '/repo': {
        common: KEY,
        worktrees: [
          makeWorktree({ path: '/repo', branch: 'behind-only', isMain: true }),
          makeWorktree({ path: '/repo.worktrees/ahead', branch: 'ahead-only' }),
          makeWorktree({ path: '/repo.worktrees/gone', branch: 'gone-branch' })
        ],
        tracking: tracking({
          'behind-only': { ahead: 0, behind: 3, upstream: 'origin/behind-only', gone: false },
          'ahead-only': { ahead: 4, behind: 0, upstream: 'origin/ahead-only', gone: false },
          'gone-branch': { ahead: 0, behind: 0, upstream: 'origin/gone-branch', gone: true }
        })
      }
    });
    const provider = new WorktreesTreeProvider(makeApi(['/repo']), git, new GroupStore(new MemoryMemento() as never));
    const byLabel = new Map(worktrees(await provider.getChildren()).map((n) => [n.label, n.contextValue]));

    assert.strictEqual(byLabel.get('repo'), 'worktree:main:ungrouped:pull');
    assert.strictEqual(byLabel.get('ahead'), 'worktree:ungrouped:push');
    assert.strictEqual(byLabel.get('gone'), 'worktree:ungrouped');
  });

  it('pins a "Current:" summary header and marks the current row with a check icon', async () => {
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/repo.worktrees/feature' } }];
    const { provider } = singleRepoProvider();
    const roots = await provider.getChildren();

    // First row is the current-worktree summary: plain "Current: <name>" + counts.
    assert.strictEqual(roots[0].kind, 'current');
    assert.strictEqual(labelText(roots[0]), 'Current: feature');
    assert.strictEqual((roots[0] as { description?: string }).description, 'feature/x  5↓ 2↑');
    // No highlight, and no icon — it reads as a banner, not a worktree row.
    assert.strictEqual(boldRanges(roots[0]), undefined);
    assert.strictEqual((roots[0] as { iconPath?: unknown }).iconPath, undefined);

    // The current worktree row keeps the check icon, with no highlight.
    const feature = worktrees(roots).find((n) => labelText(n) === 'feature')!;
    assert.strictEqual(boldRanges(feature), undefined);
    assert.strictEqual((feature.iconPath as { id: string }).id, 'check');
  });

  it('omits the summary header when no worktree is the open one', async () => {
    const { provider } = singleRepoProvider();
    const roots = await provider.getChildren();
    assert.ok(roots.every((n) => n.kind !== 'current'));
  });

  it('shows ungrouped worktrees first, then groups, with a count', async () => {
    const { provider, store } = singleRepoProvider();
    const g = await store.createGroup(KEY, 'Features');
    await store.assign(KEY, ['/repo.worktrees/feature'], g);

    const roots = await provider.getChildren();
    // main is ungrouped and comes first; the group comes last.
    assert.strictEqual(roots[0].kind, 'worktree');
    assert.strictEqual((roots[0] as WorktreeNode).label, 'repo');
    const groupNode = roots[roots.length - 1];
    assert.strictEqual(groupNode.kind, 'group');
    assert.strictEqual((groupNode as GroupTreeItem).label, 'Features');
    assert.strictEqual((groupNode as GroupTreeItem).description, '1');
  });

  it('returns a group\'s worktrees as its children, flagged as grouped', async () => {
    const { provider, store } = singleRepoProvider();
    const g = await store.createGroup(KEY, 'Features');
    await store.assign(KEY, ['/repo.worktrees/feature'], g);

    const roots = await provider.getChildren();
    const groupNode = groups(roots)[0];
    const children = await provider.getChildren(groupNode);

    assert.deepStrictEqual(
      children.map((n) => (n as WorktreeNode).label),
      ['feature']
    );
    assert.strictEqual((children[0] as WorktreeNode).contextValue, 'worktree:grouped:pull:push');
  });

  it('reflects the persisted collapsed state on the group node', async () => {
    const { provider, store } = singleRepoProvider();
    const g = await store.createGroup(KEY, 'Features');

    let groupNode = groups(await provider.getChildren())[0];
    assert.strictEqual(groupNode.collapsibleState, 2 /* Expanded */);

    await store.setCollapsed(KEY, g, true);
    groupNode = groups(await provider.getChildren())[0];
    assert.strictEqual(groupNode.collapsibleState, 1 /* Collapsed */);
  });

  it('shows one section per repo when several distinct repos are open', async () => {
    const git = makeGit({
      '/a': { common: '/a/.git', worktrees: [makeWorktree({ path: '/a', branch: 'main', isMain: true })] },
      '/b': { common: '/b/.git', worktrees: [makeWorktree({ path: '/b', branch: 'main', isMain: true })] }
    });
    const provider = new WorktreesTreeProvider(makeApi(['/a', '/b']), git, new GroupStore(new MemoryMemento() as never));

    const roots = await provider.getChildren();
    assert.deepStrictEqual(
      roots.map((n) => n.kind),
      ['repo', 'repo']
    );
    // Sections are labelled by repo name, not by a worktree folder.
    assert.deepStrictEqual(roots.map((n) => labelText(n)).sort(), ['a', 'b']);
    const children = await provider.getChildren(roots[0] as RepoTreeItem);
    assert.strictEqual(worktrees(children).length, 1);
  });

  describe('drag and drop', () => {
    it('moves a dragged worktree into the group it is dropped on', async () => {
      const { provider, store } = singleRepoProvider();
      const g = await store.createGroup(KEY, 'Features');
      const roots = await provider.getChildren();
      const feature = worktrees(roots).find((n) => n.label === 'feature')!;
      const groupNode = groups(roots)[0];

      const dt = new DataTransfer();
      provider.handleDrag([feature], dt as never);
      await provider.handleDrop(groupNode, dt as never);

      assert.strictEqual(store.groupOf(KEY, '/repo.worktrees/feature'), g);
    });

    it('ungroups a worktree dropped on empty space', async () => {
      const { provider, store } = singleRepoProvider();
      const g = await store.createGroup(KEY, 'Features');
      await store.assign(KEY, ['/repo.worktrees/feature'], g);

      const roots = await provider.getChildren();
      const groupNode = groups(roots)[0];
      const feature = (await provider.getChildren(groupNode))[0] as WorktreeNode;

      const dt = new DataTransfer();
      provider.handleDrag([feature], dt as never);
      await provider.handleDrop(undefined, dt as never);

      assert.strictEqual(store.groupOf(KEY, '/repo.worktrees/feature'), undefined);
    });

    it('reorders a group when dropped on another group', async () => {
      const { provider, store } = singleRepoProvider();
      const a = await store.createGroup(KEY, 'A');
      const b = await store.createGroup(KEY, 'B');

      const roots = await provider.getChildren();
      const [groupA, groupB] = groups(roots);

      const dt = new DataTransfer();
      provider.handleDrag([groupB], dt as never);
      await provider.handleDrop(groupA, dt as never);

      assert.deepStrictEqual(store.groupsFor(KEY).map((x) => x.id), [b, a]);
    });
  });
});
