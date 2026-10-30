import type { Geometry, Point } from "../../../../packages/shared/src/review";
/** Canonical coordinates are normalized within the unrotated PDF crop box. */
export interface PageSpace {
  width: number;
  height: number;
  transform: number[];
  box: number[];
}
export function toScreen(p: Point, s: PageSpace): Point {
  const [a, b, c, d, e, f] = s.transform,
    x = s.box[0] + p[0] * (s.box[2] - s.box[0]),
    y = s.box[1] + p[1] * (s.box[3] - s.box[1]);
  return [a * x + c * y + e, b * x + d * y + f];
}
export function toUnit(p: Point, s: PageSpace): Point {
  const [a, b, c, d, e, f] = s.transform,
    det = a * d - b * c,
    x = (d * (p[0] - e) - c * (p[1] - f)) / det,
    y = (-b * (p[0] - e) + a * (p[1] - f)) / det;
  return [
    clamp((x - s.box[0]) / (s.box[2] - s.box[0])),
    clamp((y - s.box[1]) / (s.box[3] - s.box[1])),
  ];
}
export function move(g: Geometry, delta: Point): Geometry {
  const xs = g.points.map((p) => p[0]),
    ys = g.points.map((p) => p[1]),
    dx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), delta[0])),
    dy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), delta[1]));
  return { points: g.points.map((p) => [p[0] + dx, p[1] + dy]) };
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
