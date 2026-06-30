# Changelog

## 0.0.3

- Fixed: submodules checked out inside a linked worktree are now excluded from
  the view and the "New Worktree" repository picker too (previously only
  top-level submodules were caught).
- Fixed: the repository name (e.g. `paratoo-fdcp`) is shown in the view and the
  "New Worktree" picker, instead of whichever worktree folder happened to be open
  (e.g. `2317-species-list-field-change`).

## 0.0.2

- Submodules opened in the workspace are no longer shown as separate
  repositories in the view, which had caused worktrees and groups to nest under
  an extra repo header.
- Adding a worktree to a group now uses a single picker: type a new name and
  press Enter to create the group inline, or pick an existing one.
- Groups are now listed first with the ungrouped worktrees below them (and the
  group folder icon was dropped), so groups no longer look nested under the
  ungrouped worktrees.

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
