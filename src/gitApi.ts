/**
 * Minimal typings for the built-in `vscode.git` extension API (version 1).
 * Only the members this extension actually uses are declared. See
 * https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */
import * as vscode from 'vscode';

export interface Repository {
  readonly rootUri: vscode.Uri;
}

export interface API {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  /** The git binary VS Code is configured to use. */
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}
