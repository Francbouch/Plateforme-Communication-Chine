import { expect, it, vi } from "vitest";
import { privateFileResponse } from "../apps/api/src/private-file";
const bytes = new TextEncoder().encode("0123456789");
const file = {
  object_key: "private/unchanged",
  size: bytes.length,
  filename: "Plan révision B.pdf",
  content_type: "application/pdf",
  extension: "pdf",
};
function storage() {
  const get = vi.fn(async (_key: string, options?: R2GetOptions) => {
    const range = options?.range as
      { offset: number; length: number } | undefined;
    return {
      body: new Blob([
        range ? bytes.slice(range.offset, range.offset + range.length) : bytes,
      ]).stream(),
    };
  });
  return { get, bucket: { get } as unknown as R2Bucket };
}
it.each([
  ["bytes=0-3", 206, "0123", "bytes 0-3/10"],
  ["bytes=7-", 206, "789", "bytes 7-9/10"],
  ["bytes=-3", 206, "789", "bytes 7-9/10"],
  ["bytes=8-999", 206, "89", "bytes 8-9/10"],
  ["bytes=10-", 416, "", "bytes */10"],
  ["bytes=-0", 416, "", "bytes */10"],
  ["bytes=5-2", 416, "", "bytes */10"],
  ["bytes=0-1,4-5", 416, "", "bytes */10"],
])(
  "streams only authorized byte range %s without reading R2 on invalid ranges",
  async (range, status, body, contentRange) => {
    const { get, bucket } = storage();
    const r = await privateFileResponse(
      new Request("https://private.test/file", { headers: { Range: range } }),
      bucket,
      file,
    );
    expect(r.status).toBe(status);
    expect(await r.text()).toBe(body);
    expect(r.headers.get("Content-Range")).toBe(contentRange);
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    expect(r.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(get).toHaveBeenCalledTimes(status === 206 ? 1 : 0);
  },
);
it("keeps full downloads, conservative If-Range fallback and attachment disposition private", async () => {
  const { bucket } = storage();
  const r = await privateFileResponse(
    new Request("https://private.test/file?download=1", {
      headers: { Range: "bytes=0-3", "If-Range": "old-tag" },
    }),
    bucket,
    file,
  );
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("0123456789");
  expect(r.headers.get("Content-Disposition")).toContain("attachment;");
  expect(r.headers.get("Content-Length")).toBe("10");
});
