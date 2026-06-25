import * as assert from 'assert';
import { GroupStore } from '../groupStore';
import { MemoryMemento } from './helpers';

const REPO = '/repo/.git';

describe('GroupStore', () => {
  let memento: MemoryMemento;
  let store: GroupStore;

  beforeEach(() => {
    memento = new MemoryMemento();
    store = new GroupStore(memento as never);
  });

  it('starts with no groups and no assignments', () => {
    assert.deepStrictEqual(store.groupsFor(REPO), []);
    assert.strictEqual(store.groupOf(REPO, '/repo.worktrees/a'), undefined);
  });

  it('creates groups in order and persists across instances', async () => {
    const a = await store.createGroup(REPO, 'Features');
    const b = await store.createGroup(REPO, 'Bugfixes');
    assert.deepStrictEqual(
      store.groupsFor(REPO).map((g) => g.id),
      [a, b]
    );

    const reloaded = new GroupStore(memento as never);
    assert.deepStrictEqual(
      reloaded.groupsFor(REPO).map((g) => g.name),
      ['Features', 'Bugfixes']
    );
  });

  it('keeps groups and assignments independent between repositories', async () => {
    const g = await store.createGroup('/a/.git', 'Only in A');
    await store.assign('/a/.git', ['/a.worktrees/x'], g);

    assert.ok(store.groupsFor('/a/.git').some((x) => x.name === 'Only in A'));
    assert.deepStrictEqual(store.groupsFor('/b/.git'), []);
    assert.strictEqual(store.groupOf('/a/.git', '/a.worktrees/x'), g);
    assert.strictEqual(store.groupOf('/b/.git', '/a.worktrees/x'), undefined);
  });

  it('assigns and ungroups worktrees', async () => {
    const g = await store.createGroup(REPO, 'Features');
    await store.assign(REPO, ['/wt/a', '/wt/b'], g);
    assert.strictEqual(store.groupOf(REPO, '/wt/a'), g);
    assert.strictEqual(store.groupOf(REPO, '/wt/b'), g);

    await store.assign(REPO, ['/wt/a'], undefined);
    assert.strictEqual(store.groupOf(REPO, '/wt/a'), undefined);
    assert.strictEqual(store.groupOf(REPO, '/wt/b'), g);
  });

  it('ensureGroup returns the existing group by name (case-insensitive), else creates it', async () => {
    const id = await store.createGroup(REPO, 'Features');
    assert.strictEqual(await store.ensureGroup(REPO, 'features'), id);
    assert.strictEqual(store.groupsFor(REPO).length, 1);

    const created = await store.ensureGroup(REPO, 'Bugfixes');
    assert.notStrictEqual(created, id);
    assert.deepStrictEqual(store.groupsFor(REPO).map((g) => g.name), ['Features', 'Bugfixes']);
  });

  it('renames a group', async () => {
    const g = await store.createGroup(REPO, 'Old');
    await store.renameGroup(REPO, g, 'New');
    assert.strictEqual(store.getGroup(REPO, g)?.name, 'New');
  });

  it('deletes a group and ungroups its worktrees', async () => {
    const g = await store.createGroup(REPO, 'Features');
    await store.assign(REPO, ['/wt/a'], g);
    await store.deleteGroup(REPO, g);
    assert.strictEqual(store.getGroup(REPO, g), undefined);
    assert.strictEqual(store.groupOf(REPO, '/wt/a'), undefined);
  });

  it('groupOf ignores assignments to deleted groups', async () => {
    const g = await store.createGroup(REPO, 'Features');
    await store.assign(REPO, ['/wt/a'], g);
    await store.deleteGroup(REPO, g);
    // Re-assigning to a fresh group still works after a delete.
    const g2 = await store.createGroup(REPO, 'Features 2');
    await store.assign(REPO, ['/wt/a'], g2);
    assert.strictEqual(store.groupOf(REPO, '/wt/a'), g2);
  });

  it('moves a group up and down within bounds', async () => {
    const a = await store.createGroup(REPO, 'A');
    const b = await store.createGroup(REPO, 'B');
    const c = await store.createGroup(REPO, 'C');

    await store.moveGroup(REPO, c, -1);
    assert.deepStrictEqual(store.groupsFor(REPO).map((g) => g.id), [a, c, b]);

    await store.moveGroup(REPO, a, 1);
    assert.deepStrictEqual(store.groupsFor(REPO).map((g) => g.id), [c, a, b]);

    // No-ops at the edges.
    await store.moveGroup(REPO, c, -1);
    await store.moveGroup(REPO, b, 1);
    assert.deepStrictEqual(store.groupsFor(REPO).map((g) => g.id), [c, a, b]);
  });

  it('reorders a group by dropping it onto another (inserts before the target)', async () => {
    const a = await store.createGroup(REPO, 'A');
    const b = await store.createGroup(REPO, 'B');
    const c = await store.createGroup(REPO, 'C');

    // Drag A onto C: A is removed then re-inserted at C's slot → [B, A, C].
    await store.reorderGroup(REPO, a, c);
    assert.deepStrictEqual(store.groupsFor(REPO).map((g) => g.id), [b, a, c]);
  });

  it('remembers collapsed state silently (no onDidChange) and persists it', async () => {
    const g = await store.createGroup(REPO, 'Features');
    assert.strictEqual(store.isCollapsed(REPO, g), false);

    let fired = 0;
    store.onDidChange(() => {
      fired++;
    });
    await store.setCollapsed(REPO, g, true);
    assert.strictEqual(store.isCollapsed(REPO, g), true);
    assert.strictEqual(fired, 0, 'collapse should not trigger a refresh');

    // Survives a reload (e.g. opening another window of the same repo).
    const reloaded = new GroupStore(memento as never);
    assert.strictEqual(reloaded.isCollapsed(REPO, g), true);

    await store.setCollapsed(REPO, g, false);
    assert.strictEqual(store.isCollapsed(REPO, g), false);
  });

  it('fires onDidChange when groups/assignments change', async () => {
    let fired = 0;
    store.onDidChange(() => {
      fired++;
    });
    const g = await store.createGroup(REPO, 'Features');
    await store.assign(REPO, ['/wt/a'], g);
    assert.strictEqual(fired, 2);
  });
});
