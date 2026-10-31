import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  colorValues,
  validGeometry,
  type ReviewItem,
  type ReviewType,
  type Geometry,
  type Point,
} from "../../../../packages/shared/src/review";
import { move, toScreen, toUnit, type PageSpace } from "./geometry";
import type { ReviewSession, ReviewCreateData } from "./useReview";
export type DrawingTool = "select" | Exclude<ReviewType, "discussion">;
interface Draft {
  id: string;
  type: ReviewType;
  color: ReviewItem["color"];
  geometry: Geometry;
  version?: number;
  page: number;
}
export function AnnotationLayer({
  space,
  page,
  tool,
  color,
  session,
  onDrawn,
  canEdit,
}: {
  space: PageSpace;
  page: number;
  tool: DrawingTool;
  color: ReviewItem["color"];
  session: ReviewSession;
  onDrawn: () => void;
  canEdit?: (item: ReviewItem) => boolean;
}) {
  const { t } = useTranslation(),
    [draft, setDraft] = useState<Draft | null>(null),
    [pending, setPending] = useState<Draft | null>(null);
  const gesture = useRef<{
    start: Point;
    screen: Point;
    base: Draft;
    mode: "move" | "resize" | "draw";
  } | null>(null);
  function point(e: PointerEvent<SVGSVGElement>): {
    unit: Point;
    screen: Point;
  } {
    const r = e.currentTarget.getBoundingClientRect(),
      p: Point = [
        ((e.clientX - r.left) * space.width) / r.width,
        ((e.clientY - r.top) * space.height) / r.height,
      ];
    return { unit: toUnit(p, space), screen: p };
  }
  async function save(d: Draft) {
    setPending(d);
    setDraft(d);
    try {
      if (d.version)
        await session.update(d.id, {
          version: d.version,
          geometry: d.geometry,
        });
      else await session.create(d as ReviewCreateData);
      setPending(null);
      setDraft(null);
      onDrawn();
    } catch {
      /* Draft remains visible and retryable. */
    }
  }
  function down(e: PointerEvent<SVGSVGElement>) {
    if (e.button !== 0 || session.saving || pending) return;
    const p = point(e),
      target = (e.target as SVGElement).closest("[data-review-id]"),
      selected =
        target &&
        session.items.find(
          (i) => i.id === target.getAttribute("data-review-id"),
        );
    if (tool === "select") {
      if (!selected) {
        session.setSelectedAnnotations([]);
        return;
      }
      session.selectAnnotation(selected, e.ctrlKey || e.metaKey);
      if (canEdit && !canEdit(selected)) return;
      if (e.ctrlKey || e.metaKey) return;
      session.setPanel(true);
      const base = {
        id: selected.id,
        type: selected.type,
        color: selected.color,
        geometry: selected.geometry,
        version: selected.version,
        page,
      };
      gesture.current = {
        start: p.unit,
        screen: p.screen,
        base,
        mode:
          (e.target as SVGElement).getAttribute("data-resize") === "1"
            ? "resize"
            : "move",
      };
      setDraft(base);
    } else {
      const points: Point[] =
        tool === "marker" || tool === "text" ? [p.unit] : [p.unit, p.unit];
      const base = {
        id: crypto.randomUUID(),
        type: tool,
        color,
        geometry: { points },
        page,
      };
      gesture.current = { start: p.unit, screen: p.screen, base, mode: "draw" };
      setDraft(base);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function calculate(e: PointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g) return null;
    const p = point(e);
    if (g.mode === "move")
      return {
        ...g.base,
        geometry: move(g.base.geometry, [
          p.unit[0] - g.start[0],
          p.unit[1] - g.start[1],
        ]),
      };
    if (g.mode === "resize")
      return {
        ...g.base,
        geometry: { points: [g.base.geometry.points[0], p.unit] },
      };
    if (g.base.type === "marker" || g.base.type === "text") return g.base;
    if (g.base.type === "freehand") {
      const current = draft ?? g.base,
        points = current.geometry.points;
      if (
        points.length < 256 &&
        Math.hypot(
          p.unit[0] - points.at(-1)![0],
          p.unit[1] - points.at(-1)![1],
        ) > 0.002
      )
        return { ...current, geometry: { points: [...points, p.unit] } };
      return current;
    }
    return { ...g.base, geometry: { points: [g.start, p.unit] } };
  }
  function up(e: PointerEvent<SVGSVGElement>) {
    const g = gesture.current,
      d = calculate(e);
    if (!g || !d) return;
    const p = point(e);
    gesture.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (
      g.mode === "move" &&
      Math.hypot(p.screen[0] - g.screen[0], p.screen[1] - g.screen[1]) < 2
    ) {
      setDraft(null);
      return;
    }
    if (!validGeometry(d.type, d.geometry)) {
      setDraft(null);
      return;
    }
    void save(d);
  }
  const rendered = session.items.filter((i) => !draft || i.id !== draft.id);
  function shape(
    i: Pick<ReviewItem, "id" | "type" | "color" | "geometry"> & {
      number?: number;
      content?: string;
    },
    temporary = false,
  ) {
    const p = i.geometry.points.map((point) => toScreen(point, space)),
      stroke = colorValues[i.color],
      selected =
        session.selectedAnnotations.includes(i.id) ||
        (!!session.selected &&
          session.items.find((a) => a.id === i.id)?.point_id ===
            session.selected),
      props = {
        stroke,
        strokeWidth: selected ? 3 : 2,
        vectorEffect: "non-scaling-stroke" as const,
      };
    if (!p.length) return null;
    return (
      <g
        key={i.id}
        data-review-id={temporary ? undefined : i.id}
        data-testid={temporary ? "annotation-draft" : `annotation-${i.id}`}
        aria-label={
          i.number ? `#${String(i.number).padStart(3, "0")}` : undefined
        }
        className={tool === "select" ? "annotation-selectable" : ""}
      >
        {i.type === "marker" ? (
          <>
            <circle cx={p[0][0]} cy={p[0][1]} r="17" fill="white" {...props} />
            <text
              x={p[0][0]}
              y={p[0][1] + 4}
              textAnchor="middle"
              fill={stroke}
              fontSize="11"
              fontWeight="700"
            >
              {"•"}
            </text>
          </>
        ) : i.type === "text" ? (
          <>
            <rect
              x={p[0][0] - 3}
              y={p[0][1] - 18}
              width={Math.min(
                400,
                Math.max(100, (i.content?.slice(0, 80).length ?? 4) * 8),
              )}
              height="26"
              fill="white"
              opacity=".9"
              {...props}
            />
            <text x={p[0][0]} y={p[0][1]} fill={stroke} fontSize="14">
              {i.content?.slice(0, 80) || t("textNote")}
            </text>
          </>
        ) : i.type === "rectangle" || i.type === "highlight" ? (
          <rect
            x={Math.min(p[0][0], p[1][0])}
            y={Math.min(p[0][1], p[1][1])}
            width={Math.abs(p[1][0] - p[0][0])}
            height={Math.abs(p[1][1] - p[0][1])}
            fill={i.type === "highlight" ? stroke : "transparent"}
            fillOpacity={i.type === "highlight" ? 0.25 : 0}
            {...props}
          />
        ) : i.type === "arrow" ? (
          <>
            <line
              x1={p[0][0]}
              y1={p[0][1]}
              x2={p[1][0]}
              y2={p[1][1]}
              stroke="transparent"
              strokeWidth="16"
            />
            <line
              x1={p[0][0]}
              y1={p[0][1]}
              x2={p[1][0]}
              y2={p[1][1]}
              {...props}
            />
            <path d={arrowHead(p[0], p[1])} fill="none" {...props} />
          </>
        ) : (
          <polyline
            points={p.map((v) => v.join(",")).join(" ")}
            fill="none"
            {...props}
          />
        )}
        {selected &&
          (i.type === "rectangle" || i.type === "highlight") &&
          !temporary && (
            <circle
              data-resize="1"
              data-testid="annotation-resize"
              cx={p[1][0]}
              cy={p[1][1]}
              r="7"
              stroke={stroke}
              fill="white"
            />
          )}
      </g>
    );
  }
  return (
    <>
      <svg
        className="annotation-layer"
        data-testid="annotation-layer"
        viewBox={`0 0 ${space.width} ${space.height}`}
        preserveAspectRatio="none"
        onPointerDown={down}
        onPointerMove={(e) => {
          const d = calculate(e);
          if (d) setDraft(d);
        }}
        onPointerUp={up}
        onPointerCancel={() => {
          gesture.current = null;
          setDraft(null);
        }}
      >
        {rendered.map((i) => shape(i))}
        {draft && shape(draft, true)}
      </svg>
      {pending && !session.saving && (
        <div className="annotation-retry" role="alert">
          <span>{t("annotationUnsaved")}</span>
          <button onClick={() => void save(pending)}>{t("retry")}</button>
          <button
            onClick={() => {
              setDraft(null);
              setPending(null);
              session.setError("");
            }}
          >
            {t("cancel")}
          </button>
        </div>
      )}
    </>
  );
}
function arrowHead(a: Point, b: Point) {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]),
    size = 12;
  return `M${b[0] - size * Math.cos(angle - 0.5)},${b[1] - size * Math.sin(angle - 0.5)} L${b[0]},${b[1]} L${b[0] - size * Math.cos(angle + 0.5)},${b[1] - size * Math.sin(angle + 0.5)}`;
}
