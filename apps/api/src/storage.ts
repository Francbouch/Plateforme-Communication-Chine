/** No browser-chosen object keys. Resource authorization precedes every adapter call. */
export interface AssetScope {
  organizationId: string;
  projectId: string;
  documentId: string;
}
export function assetKey(
  scope: AssetScope,
  assetId = crypto.randomUUID(),
): string {
  for (const id of [...Object.values(scope), assetId])
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid storage scope");
  return `organizations/${scope.organizationId}/projects/${scope.projectId}/documents/${scope.documentId}/assets/${assetId}`;
}
// Streaming callers must supply a known-length Request/Response body or FixedLengthStream.
export interface PrivateStorage {
  read(key: string): Promise<ReadableStream | null>;
  stage(
    key: string,
    body: ReadableStream | ArrayBuffer,
    options: { contentType: string; sha256: string },
  ): Promise<void>;
  removeIncomplete(key: string): Promise<void>;
}
export class R2Storage implements PrivateStorage {
  constructor(private bucket: R2Bucket) {}
  async read(key: string) {
    return (await this.bucket.get(key))?.body ?? null;
  }
  async stage(
    key: string,
    body: ReadableStream | ArrayBuffer,
    options: { contentType: string; sha256: string },
  ) {
    if (!/^[a-f0-9]{64}$/i.test(options.sha256))
      throw new Error("SHA-256 required");
    const result = await this.bucket.put(key, body, {
      sha256: options.sha256,
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: options.contentType },
      customMetadata: { validation: "quarantine" },
    });
    if (!result) throw new Error("Asset already exists");
  }
  async removeIncomplete(key: string) {
    const object = await this.bucket.head(key);
    if (object?.customMetadata?.validation === "quarantine")
      await this.bucket.delete(key);
  }
}
// Low-level quarantine adapter retained for future scanning workflows.
// Authenticated streaming uploads and immutable revision finalization live in documents.ts.
