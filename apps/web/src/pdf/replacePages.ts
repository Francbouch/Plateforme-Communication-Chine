import { PDFDocument } from "@cantoo/pdf-lib";
import { maxUploadBytes } from "../../../../packages/shared/src/documents";
export class ReplacementError extends Error {
  constructor(
    public code: "pageRange" | "pageCount" | "pageDimensions" | "pdfLimit",
  ) {
    super(code);
  }
}
export function replacementPages(text: string, count: number) {
  const pages = text.split(",").map((s) => s.trim());
  if (!pages.length || pages.some((p) => !/^\d+$/.test(p)))
    throw new ReplacementError("pageRange");
  const indices = pages.map((p) => Number(p) - 1);
  if (
    new Set(indices).size !== indices.length ||
    indices.some((n) => n < 0 || n >= count)
  )
    throw new ReplacementError("pageRange");
  return indices;
}
export async function replacePdfPages(
  original: Uint8Array,
  replacement: Uint8Array,
  targets: string,
) {
  if (
    original.byteLength > maxUploadBytes ||
    replacement.byteLength > maxUploadBytes ||
    !replacement.byteLength
  )
    throw new ReplacementError("pdfLimit");
  const document = await PDFDocument.load(original, { updateMetadata: false }),
    source = await PDFDocument.load(replacement, { updateMetadata: false });
  if (document.getPageCount() > 2000) throw new ReplacementError("pdfLimit");
  const indices = replacementPages(targets, document.getPageCount());
  if (source.getPageCount() !== indices.length)
    throw new ReplacementError("pageCount");
  for (let i = 0; i < indices.length; i++) {
    const a = document.getPage(indices[i]),
      b = source.getPage(i);
    const ar = ((a.getRotation().angle % 360) + 360) % 360,
      br = ((b.getRotation().angle % 360) + 360) % 360;
    const ab = a.getCropBox(),
      bb = b.getCropBox();
    if (
      ar !== br ||
      Math.abs(ab.width - bb.width) > 1 ||
      Math.abs(ab.height - bb.height) > 1
    )
      throw new ReplacementError("pageDimensions");
  }
  const copied = await document.copyPages(source, source.getPageIndices());
  indices.forEach((target, i) => {
    document.removePage(target);
    document.insertPage(target, copied[i]);
  });
  const bytes = await document.save();
  if (bytes.byteLength > maxUploadBytes) throw new ReplacementError("pdfLimit");
  const validated = await PDFDocument.load(bytes, { updateMetadata: false });
  if (validated.getPageCount() !== document.getPageCount())
    throw new ReplacementError("pageCount");
  return bytes;
}
