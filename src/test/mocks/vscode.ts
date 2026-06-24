/**
 * Minimal in-memory stand-in for the `vscode` module so the extension's
 * library code can be unit-tested in plain Node. Only the APIs actually used
 * by the modules under test are implemented.
 */

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();

  readonly event = (listener: (e: T) => unknown) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };

  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      listener(e);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable {
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => disposables.forEach((d) => d.dispose()));
  }

  constructor(private readonly callOnDispose: () => unknown) {}

  dispose(): void {
    this.callOnDispose();
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: unknown;
  contextValue?: string;
  resourceUri?: unknown;
  iconPath?: unknown;
  command?: unknown;

  constructor(
    public label: string | { label: string; highlights?: [number, number][] },
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class MarkdownString {
  constructor(public value: string = '') {}
}

export const Uri = {
  file(fsPath: string) {
    return { fsPath, path: fsPath, scheme: 'file' };
  }
};

export class DataTransferItem {
  constructor(public readonly value: unknown) {}
}

export class DataTransfer {
  private readonly items = new Map<string, DataTransferItem>();

  get(mime: string): DataTransferItem | undefined {
    return this.items.get(mime);
  }

  set(mime: string, item: DataTransferItem): void {
    this.items.set(mime, item);
  }
}

/** Mutable so tests can set the "currently open" worktree folders. */
export const workspace: { workspaceFolders?: { uri: { fsPath: string } }[] } = {
  workspaceFolders: undefined
};
