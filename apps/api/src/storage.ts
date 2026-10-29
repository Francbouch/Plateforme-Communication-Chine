export interface PrivateStorage {
  read(key: string): Promise<ReadableStream | null>;
  remove(key: string): Promise<void>;
}
export class R2Storage implements PrivateStorage {
  constructor(private bucket: R2Bucket) {}
  async read(key: string) {
    return (await this.bucket.get(key))?.body ?? null;
  }
  async remove(key: string) {
    await this.bucket.delete(key);
  }
}
// No public upload/download endpoints in phase 1. Phase 2 must resolve an asset
// through a tenant/project/document grant before calling this adapter.
