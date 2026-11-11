export interface WorkspaceReadGrant {
  readonly conversationId: string;
  readonly toolCallId: string;
  readonly canonicalPath: string;
}

export interface WorkspaceGrantStore {
  grantRead(grant: WorkspaceReadGrant): void;
  hasRead(grant: WorkspaceReadGrant): boolean;
  consumeRead(grant: WorkspaceReadGrant): boolean;
}

export class InMemoryWorkspaceGrantStore implements WorkspaceGrantStore {
  readonly #readGrants = new Set<string>();

  grantRead(grant: WorkspaceReadGrant): void {
    this.#readGrants.add(grantKey(grant));
  }

  hasRead(grant: WorkspaceReadGrant): boolean {
    return this.#readGrants.has(grantKey(grant));
  }

  consumeRead(grant: WorkspaceReadGrant): boolean {
    const key = grantKey(grant);
    if (!this.#readGrants.has(key)) return false;
    this.#readGrants.delete(key);
    return true;
  }
}

function grantKey(grant: WorkspaceReadGrant): string {
  return JSON.stringify([
    grant.conversationId,
    grant.toolCallId,
    grant.canonicalPath,
    "read",
  ]);
}
