import { describe, it, expect } from "vitest";
import {
  extractNotes,
  type TextFragment,
} from "../apps/web/src/pdf-translation/extract";
import {
  detectNote,
  linguisticNote,
  segmentKey,
} from "../packages/shared/src/pdf-translation";
import {
  protect,
  verifyTechnical,
} from "../apps/api/src/translation/protection";
const fragment = (
  str: string,
  x: number,
  y: number,
  angle = 0,
  width = str.length * 6,
): TextFragment => {
  const r = (angle * Math.PI) / 180;
  return {
    str,
    width,
    height: 10,
    transform: [
      10 * Math.cos(r),
      10 * Math.sin(r),
      -10 * Math.sin(r),
      10 * Math.cos(r),
      x,
      y,
    ],
  };
};
describe("digital PDF note extraction prototype", () => {
  it("joins adjacent fragments while preserving dimensions and separate columns/baselines", () => {
    const notes = extractNotes(
      [
        fragment("REMOVE", 20, 200, 0, 36),
        fragment("SHARP EDGES", 60, 200),
        fragment("MATERIAL", 200, 200),
        fragment("GENERAL NOTES", 20, 180),
        fragment("±0.010", 20, 160),
      ],
      [0, 0, 300, 300],
    );
    expect(notes.map((n) => n.text)).toEqual([
      "REMOVE SHARP EDGES",
      "MATERIAL",
      "GENERAL NOTES",
    ]);
    expect(notes[0].x).toBeCloseTo(20 / 300);
    expect(notes[0].y).toBeCloseTo(200 / 300);
  });
  it.each([0, 90, -90, 45, 180])(
    "retains orientation %s and full PDF transform",
    (angle) => {
      const item = fragment("REMOVE SHARP EDGES", 100, 100, angle),
        note = extractNotes([item], [0, 0, 300, 400])[0];
      expect(note.angle).toBeCloseTo(angle);
      expect(note.transform).toHaveLength(6);
      expect(note.font_size).toBeCloseTo(10);
    },
  );
  it("handles cropped page boxes and scanned pages without fabricating notes", () => {
    expect(extractNotes([], [0, 0, 300, 300])).toEqual([]);
    expect(
      extractNotes([fragment("GENERAL NOTES", 40, 50)], [20, 30, 220, 230])[0]
        .x,
    ).toBe(0.1);
  });
  it("does not interpret dimensions, files or references as linguistic notes", () => {
    for (const text of [
      "±0.010",
      "Ø0.530",
      "M8 × 1.25",
      "1/4-20 UNC",
      '9/16"',
      "AISI 304",
      "ISO 2768-mK",
      "LC-120-003",
      "drawing.pdf",
    ])
      expect(linguisticNote(text), text).toBe(false);
  });
  it("keeps ambiguous language uncertain and detects only clear supported notes", () => {
    expect(detectNote("MATERIAL")).toBe("en");
    expect(detectNote("REMOVE SHARP EDGES")).toBe("en");
    expect(detectNote("Enlever les arêtes")).toBe("fr");
    expect(detectNote("去除锐边")).toBe("zh-CN");
    expect(detectNote("PLATE")).toBe("uncertain");
  });
  it("uses content and geometry fingerprints tied to exact revision and page", async () => {
    const s = extractNotes([fragment("MATERIAL", 20, 20)], [0, 0, 300, 300])[0];
    const a = await segmentKey("a", "1".repeat(64), 1, s);
    expect(await segmentKey("a", "1".repeat(64), 1, s)).toBe(a);
    for (const key of [
      await segmentKey("b", "1".repeat(64), 1, s),
      await segmentKey("a", "1".repeat(64), 2, s),
      await segmentKey("a", "1".repeat(64), 1, {
        ...s,
        text: "REMOVE SHARP EDGES",
      }),
      await segmentKey("a", "1".repeat(64), 1, { ...s, x: 0.5 }),
    ])
      expect(key).not.toBe(a);
  });
  it("protects entire fractions, filenames, diameter, units, standards and tolerances without conversion", () => {
    const text =
      'REMOVE SHARP EDGES ±0.010 Ø0.530 M8 × 1.25 1/4-20 UNC 9/16" AISI 304 ISO 2768-mK LC-120-003 drawing.pdf 3 mm';
    const p = protect(text, [], "en", "zh-CN", "abcdef");
    for (const token of [
      "±0.010",
      "Ø0.530",
      "M8 × 1.25",
      "1/4-20 UNC",
      '9/16"',
      "AISI 304",
      "ISO 2768-mK",
      "LC-120-003",
      "drawing.pdf",
      "3 mm",
    ])
      expect(p.text).not.toContain(token);
    const restored = p.restore(
      p.text.replace("REMOVE SHARP EDGES", "去除锐边"),
    );
    expect(restored.warnings).toEqual([]);
    expect(restored.text).toContain("Ø0.530");
    expect(verifyTechnical(text, restored.text)).toEqual([]);
    expect(
      p.restore(p.text.replace(p.tokens[0].token, "999")).warnings.length,
    ).toBeGreaterThan(0);
  });
});
it("preserves spaced signs, GD&T symbols, lowercase identifiers and Unicode/uppercase filenames", () => {
  const text =
    "REMOVE SHARP EDGES ± 0.010 - 0.25 + 0.10 ⟂ ∥ ⌖ lc-120-003 图纸.PDF";
  const p = protect(text, [], "en", "zh-CN", "abcd");
  for (const value of ["±", "⟂", "∥", "⌖", "lc-120-003", "图纸.PDF"])
    expect(p.text).not.toContain(value);
  const restored = p.restore(p.text.replace("REMOVE SHARP EDGES", "去除锐边"));
  expect(restored.warnings).toEqual([]);
  expect(restored.text).toContain("± 0.010");
  expect(verifyTechnical(text, restored.text.replace("±", ""))).not.toEqual([]);
  expect(linguisticNote("lc-120-003")).toBe(false);
});
