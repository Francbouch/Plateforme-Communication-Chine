import { HttpError } from "./types";

/** Call only after resource authorization. All bytes remain behind the Worker. */
export async function privateFileResponse(
  request: Request,
  bucket: R2Bucket | undefined,
  file: {
    object_key: string;
    size: number;
    filename: string;
    content_type: string;
    extension: string;
  },
  attachment = false,
) {
  if (!bucket) throw new HttpError(503, "R2 unavailable");
  const headers = new Headers({
    "Content-Type": file.content_type,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": `${attachment || new URL(request.url).searchParams.get("download") === "1" || !["pdf", "png", "jpg", "jpeg", "webp"].includes(file.extension) ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  });
  const range = request.headers.has("If-Range")
    ? null
    : request.headers.get("Range");
  let start = 0,
    end = file.size - 1;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), end) : end;
      } else {
        const suffix = Number(m[2]);
        start = suffix > 0 ? Math.max(0, file.size - suffix) : file.size;
      }
    }
    if (
      !m ||
      (!m[1] && !m[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= file.size
    ) {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
  }
  const object = await bucket.get(
    file.object_key,
    range ? { range: { offset: start, length: end - start + 1 } } : undefined,
  );
  if (!object) throw new HttpError(404, "File missing from storage");
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
