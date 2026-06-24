# Changelog

## 0.0.1

Initial release.

- Worktree list in the Source Control view, showing each worktree's name,
  branch, and upstream ahead/behind commit counts. The current worktree is
  marked with a check, with a `Current: <name>` summary row pinned to the top.
- Create worktrees from the `+` button — pick an existing local/remote branch or
  create a new branch (base branch first, then name, like VS Code's own flow).
  Worktrees are created in the `<repo>.worktrees/<name>` layout.
- Open a worktree on click (or in a new window), copy its path, or remove it.
- Pull / push a worktree's branch from inline ↓ / ↑ buttons (shown when it's
  behind / ahead of upstream), each after a confirmation — works on any
  worktree's branch without switching to it.
- Organise worktrees into groups: create/rename/delete groups, add/remove
  worktrees, drag-and-drop between groups, reorder groups, and remembered
  collapsed/expanded state per repository.
- Automatic refresh while the view is visible (configurable via
  `simpleWorktrees.refreshInterval`).
