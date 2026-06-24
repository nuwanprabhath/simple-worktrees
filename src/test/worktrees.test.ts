import * as assert from 'assert';
import { parseTracking, parseWorktrees } from '../worktrees';

describe('parseWorktrees', () => {
  it('parses multiple worktrees and flags the first as main', () => {
    const out = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo.worktrees/feature',
      'HEAD def456',
      'branch refs/heads/feature/x',
      ''
    ].join('\n');

    const result = parseWorktrees(out);
    assert.strictEqual(result.length, 2);

    assert.deepStrictEqual(
      { path: result[0].path, branch: result[0].branch, isMain: result[0].isMain },
      { path: '/repo', branch: 'main', isMain: true }
    );
    assert.deepStrictEqual(
      { path: result[1].path, branch: result[1].branch, isMain: result[1].isMain },
      { path: '/repo.worktrees/feature', branch: 'feature/x', isMain: false }
    );
  });

  it('handles detached, bare and locked worktrees', () => {
    const out = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo.worktrees/detached',
      'HEAD deadbeef',
      'detached',
      '',
      'worktree /repo.worktrees/locked',
      'HEAD cafef00d',
      'branch refs/heads/wip',
      'locked',
      ''
    ].join('\n');

    const [, detached, locked] = parseWorktrees(out);
    assert.strictEqual(detached.detached, true);
    assert.strictEqual(detached.branch, undefined);
    assert.strictEqual(detached.head, 'deadbeef');
    assert.strictEqual(locked.locked, true);
    assert.strictEqual(locked.branch, 'wip');
  });

  it('treats a "locked <reason>" line as locked', () => {
    const out = ['worktree /repo', 'HEAD abc', 'branch refs/heads/main', 'locked on purpose', ''].join('\n');
    assert.strictEqual(parseWorktrees(out)[0].locked, true);
  });

  it('returns an empty array for empty output', () => {
    assert.deepStrictEqual(parseWorktrees(''), []);
    assert.deepStrictEqual(parseWorktrees('\n\n'), []);
  });
});

describe('parseTracking', () => {
  it('parses ahead/behind counts', () => {
    const out = [
      'dev/1.0.11\torigin/dev/1.0.11\t[behind 36]',
      'alpha\torigin/alpha\t[ahead 60, behind 18]',
      'main\torigin/main\t'
    ].join('\n');

    const map = parseTracking(out);
    assert.deepStrictEqual(map.get('dev/1.0.11'), {
      ahead: 0,
      behind: 36,
      upstream: 'origin/dev/1.0.11',
      gone: false
    });
    assert.deepStrictEqual(map.get('alpha'), {
      ahead: 60,
      behind: 18,
      upstream: 'origin/alpha',
      gone: false
    });
    // up-to-date branch: upstream set, no counts
    assert.deepStrictEqual(map.get('main'), { ahead: 0, behind: 0, upstream: 'origin/main', gone: false });
  });

  it('marks a gone upstream', () => {
    const map = parseTracking('feature\torigin/feature\t[gone]');
    assert.deepStrictEqual(map.get('feature'), { ahead: 0, behind: 0, upstream: 'origin/feature', gone: true });
  });

  it('omits branches without an upstream', () => {
    const map = parseTracking('local-only\t\t');
    assert.strictEqual(map.has('local-only'), false);
    assert.strictEqual(map.size, 0);
  });
});
