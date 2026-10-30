import { it, expect } from "vitest";
import {
  PDFDocument,
  StandardFonts,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
  degrees,
} from "@cantoo/pdf-lib";
import {
  toScreen,
  toUnit,
  move,
  type PageSpace,
} from "../apps/web/src/review/geometry";
import {
  replacePdfPages,
  replacementPages,
} from "../apps/web/src/pdf/replacePages";
for (const transform of [
  [2, 0, 0, -2, -20, 640],
  [0, 3, 3, 0, -60, -30],
  [-4, 0, 0, 4, 840, -80],
  [0, -2, -2, 0, 640, 420],
])
  it(`keeps canonical coordinates across scale/rotation/crop transform ${transform.join(",")}`, () => {
    const space: PageSpace = {
      width: 1000,
      height: 1200,
      box: [10, 20, 210, 320],
      transform,
    };
    for (const p of [
      [0.2, 0.3],
      [0.8, 0.9],
      [0, 1],
    ] as [number, number][]) {
      const restored = toUnit(toScreen(p, space), space);
      expect(restored[0]).toBeCloseTo(p[0], 10);
      expect(restored[1]).toBeCloseTo(p[1], 10);
    }
  });
it("moves shapes together while clamping their normalized bounding box", () => {
  const g = move(
    {
      points: [
        [0.1, 0.2],
        [0.4, 0.6],
      ],
    },
    [2, -2],
  );
  expect(g.points[0][0]).toBeCloseTo(0.7);
  expect(g.points[1][0]).toBe(1);
  expect(g.points[0][1]).toBe(0);
  expect(g.points[1][1]).toBeCloseTo(0.4);
});
async function pdf(
  labels: string[],
  size: [number, number] = [300, 300],
  rotation = 0,
) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of labels) {
    const p = doc.addPage(size);
    p.setRotation(degrees(rotation));
    p.drawText(label, { x: 20, y: 240, font, size: 16 });
  }
  return doc.save();
}
function pageStream(doc: PDFDocument, index: number) {
  const contents = doc.getPage(index).node.Contents();
  const entries =
    contents instanceof PDFArray ? contents.asArray() : [contents];
  return entries
    .map((ref) => doc.context.lookup(ref))
    .filter((v): v is PDFRawStream => v instanceof PDFRawStream)
    .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString())
    .join("\n");
}
it("replaces selected pages with actual new content and leaves original bytes intact", async () => {
  const original = await pdf([
      "Original one",
      "Original two",
      "Original three",
    ]),
    copy = original.slice(),
    replacement = await pdf(["REPLACED PAGE"]);
  const output = await replacePdfPages(original, replacement, "2"),
    loaded = await PDFDocument.load(output),
    before = await PDFDocument.load(original);
  expect(loaded.getPageCount()).toBe(3);
  expect(pageStream(loaded, 0)).toBe(pageStream(before, 0));
  expect(pageStream(loaded, 2)).toBe(pageStream(before, 2));
  expect(pageStream(loaded, 1)).toContain(
    Buffer.from("REPLACED PAGE").toString("hex").toUpperCase(),
  );
  expect(pageStream(loaded, 1)).not.toBe(pageStream(before, 1));
  expect(original).toEqual(copy);
});
it("replaces multiple pages in the requested order", async () => {
  const out = await replacePdfPages(
      await pdf(["A", "B", "C"]),
      await pdf(["X", "Y"]),
      "3,1",
    ),
    doc = await PDFDocument.load(out);
  expect(pageStream(doc, 2)).toContain("58");
  expect(pageStream(doc, 0)).toContain("59");
});
it("rejects duplicate/missing page targets and a mismatched replacement count", async () => {
  expect(() => replacementPages("1,1", 3)).toThrow("pageRange");
  expect(() => replacementPages("0,4", 3)).toThrow("pageRange");
  await expect(
    replacePdfPages(await pdf(["A", "B"]), await pdf(["X"]), "1,2"),
  ).rejects.toThrow("pageCount");
});
it("rejects incompatible page dimensions and orientations", async () => {
  await expect(
    replacePdfPages(await pdf(["A"]), await pdf(["X"], [500, 500]), "1"),
  ).rejects.toThrow("pageDimensions");
  await expect(
    replacePdfPages(await pdf(["A"]), await pdf(["X"], [300, 300], 90), "1"),
  ).rejects.toThrow("pageDimensions");
});
