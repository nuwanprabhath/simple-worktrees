import * as assert from 'assert';
import { getUniqueRepos } from '../repos';
import { makeApi, makeGit, makeWorktree } from './helpers';

describe('getUniqueRepos', () => {
  it('collapses worktrees of the same repo and prefers the main worktree', async () => {
    // Both the main checkout and a linked worktree of /repo are open.
    const api = makeApi(['/repo.worktrees/feature', '/repo']);
    const git = makeGit({
      '/repo': { common: '/repo/.git', worktrees: [] },
      '/repo.worktrees/feature': { common: '/repo/.git', worktrees: [] }
    });

    const unique = await getUniqueRepos(api, git);
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(unique[0].repoKey, '/repo/.git');
    // Representative is the main worktree (dirname of the common dir).
    assert.strictEqual(unique[0].root, '/repo');
  });

  it('keeps genuinely distinct repos separate', async () => {
    const api = makeApi(['/a', '/b']);
    const git = makeGit({
      '/a': { common: '/a/.git', worktrees: [] },
      '/b': { common: '/b/.git', worktrees: [] }
    });

    const unique = await getUniqueRepos(api, git);
    assert.deepStrictEqual(
      unique.map((u) => u.root).sort(),
      ['/a', '/b']
    );
  });

  it('excludes submodules (their common-dir is under .git/modules)', async () => {
    const api = makeApi(['/repo', '/repo/runner', '/repo/vendor/lib']);
    const git = makeGit({
      '/repo': { common: '/repo/.git', worktrees: [] },
      '/repo/runner': { common: '/repo/.git/modules/runner', worktrees: [] },
      '/repo/vendor/lib': { common: '/repo/.git/modules/vendor/lib', worktrees: [] }
    });

    const unique = await getUniqueRepos(api, git);
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(unique[0].repoKey, '/repo/.git');
    assert.strictEqual(unique[0].name, 'repo');
  });

  it('names a repo after its main worktree even when only a linked worktree is open', async () => {
    const api = makeApi(['/repo.worktrees/feature']);
    const git = makeGit({ '/repo.worktrees/feature': { common: '/repo/.git', worktrees: [] } });

    const unique = await getUniqueRepos(api, git);
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(unique[0].name, 'repo');
    assert.strictEqual(unique[0].root, '/repo.worktrees/feature');
  });

  it('falls back to the path when commonDir fails (not collapsed)', async () => {
    const api = makeApi(['/weird']);
    const git = makeGit({ '/weird': { common: '/weird/.git', worktrees: [makeWorktree({ path: '/weird', isMain: true })] } }, [
      '/weird'
    ]);

    const unique = await getUniqueRepos(api, git);
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(unique[0].repoKey, '/weird');
    assert.strictEqual(unique[0].root, '/weird');
  });
});
