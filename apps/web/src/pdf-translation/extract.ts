import {
  type PdfSegment,
  linguisticNote,
} from "../../../../packages/shared/src/pdf-translation";
export interface TextFragment {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}
const rounded = (n: number) => Math.round(n * 1e6) / 1e6;
/** Group only adjacent, collinear fragments; never bridge columns or a new baseline. */
export function extractNotes(
  items: TextFragment[],
  box: number[],
): PdfSegment[] {
  const w = box[2] - box[0],
    h = box[3] - box[1];
  if (!(w > 0 && h > 0)) return [];
  const lines: {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
    transform: number[];
    order: number;
    end: boolean;
  }[] = [];
  for (const [order, item] of items.slice(0, 10000).entries()) {
    if (
      !item.str.trim() ||
      item.transform.length !== 6 ||
      !item.transform.every(Number.isFinite)
    )
      continue;
    const [a, b, c, d, x, y] = item.transform,
      height = Math.max(Math.hypot(c, d), item.height, 1),
      angle = (Math.atan2(b, a) * 180) / Math.PI;
    const last = lines.at(-1),
      rad = (angle * Math.PI) / 180;
    const along = last
      ? (x - last.x) * Math.cos(rad) + (y - last.y) * Math.sin(rad)
      : 0;
    const across = last
      ? Math.abs(-(x - last.x) * Math.sin(rad) + (y - last.y) * Math.cos(rad))
      : 0;
    const gap = last ? along - last.width : 0;
    if (
      last &&
      !last.end &&
      Math.abs(last.angle - angle) < 0.1 &&
      across < Math.min(last.height, height) * 0.25 &&
      height / last.height > 0.8 &&
      height / last.height < 1.25 &&
      gap >= -0.1 &&
      gap < height * 0.75 &&
      last.text.length + item.str.length < 600
    ) {
      last.text +=
        (gap > height * 0.12 && !/\s$/.test(last.text) && !/^\s/.test(item.str)
          ? " "
          : "") + item.str;
      last.width = Math.max(last.width, along + item.width);
      last.end = !!item.hasEOL;
    } else
      lines.push({
        text: item.str,
        x,
        y,
        width: item.width,
        height,
        angle,
        transform: [...item.transform],
        order,
        end: !!item.hasEOL,
      });
  }
  return lines
    .filter(
      (l) => linguisticNote(l.text) && l.width > 0 && l.text.length <= 600,
    )
    .filter(
      (l) => l.x >= box[0] && l.x <= box[2] && l.y >= box[1] && l.y <= box[3],
    )
    .slice(0, 200)
    .map((l) => ({
      text: l.text,
      x: rounded((l.x - box[0]) / w),
      y: rounded((l.y - box[1]) / h),
      width: rounded(Math.min(l.width / w, 4)),
      height: rounded(Math.min(l.height / h, 1)),
      angle: rounded(l.angle),
      font_size: rounded(l.height),
      transform: l.transform.map(rounded),
      order: l.order,
    }));
}
