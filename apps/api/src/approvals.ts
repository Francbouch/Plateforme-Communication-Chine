import { Hono } from "hono";
import { z } from "zod";
import { Store, projectScope } from "./database";
import { HttpError, type Bindings, type Principal } from "./types";
import {
  approvalCreate,
  approvalFields,
  approvalAction,
  approvalStatuses,
  approvalPurposes,
  type Approval,
  type RevisionApproval,
} from "../../../packages/shared/src/approvals";
import { requestPriorities } from "../../../packages/shared/src/messages";
type Vars = { store: Store; principal: Principal; requestId: string };
const time = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const v = schema.safeParse(value);
  if (!v.success)
    throw new HttpError(400, "Invalid approval data or missing justification");
  return v.data;
}
function id(value: unknown) {
  return parse(z.uuid(), value);
}
function today() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
function page(value: string | undefined) {
  return parse(z.coerce.number().int().min(0).max(10000), value ?? 0);
}
const select = `SELECT a.*,d.name AS document_name,d.number AS document_number,r.label AS revision_label,p.name AS requester,decider.name AS decider,c.conversation_id,CASE WHEN r.ordinal=(SELECT MAX(ordinal) FROM document_revisions WHERE document_id=a.document_id) THEN 1 ELSE 0 END AS is_latest FROM approval_requests a JOIN documents d ON d.id=a.document_id JOIN document_revisions r ON r.id=a.revision_id JOIN profiles p ON p.id=a.requester_id LEFT JOIN profiles decider ON decider.id=a.decided_by LEFT JOIN conversation_messages c ON c.id=a.message_id`;
async function revision(s: Store, key: string) {
  const r = await s
    .statement(
      "SELECT r.id,r.document_id,d.project_id,d.name,r.label FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE r.id=?",
      key,
    )
    .first<{
      id: string;
      document_id: string;
      project_id: string;
      name: string;
      label: string;
    }>();
  if (!r) throw new HttpError(404, "Revision not found");
  const p = await s.requireProject(r.project_id, true);
  return { ...r, organization_id: p.organization_id };
}
async function row(s: Store, value: unknown) {
  const a = await s
    .statement(`${select} WHERE a.id=? AND a.deleted_at IS NULL`, id(value))
    .first<Approval>();
  if (!a) throw new HttpError(404, "Approval not found");
  const p = await s.requireProject(a.project_id, true);
  if (a.status === "draft" && a.requester_id !== s.userId)
    throw new HttpError(403, "Draft belongs to its requester");
  return { a, organization_id: p.organization_id };
}
function guard(s: Store, project: string) {
  const g = projectScope("p", s.userId, true);
  return {
    text: `EXISTS(SELECT 1 FROM projects p WHERE p.id=? AND ${g.text})`,
    args: [project, ...g.args],
  };
}
function event(
  s: Store,
  key: string,
  action: string,
  payload: unknown,
  condition = "changes()>0",
  args: unknown[] = [],
  eventId = crypto.randomUUID(),
) {
  return s.statement(
    `INSERT INTO approval_events(id,approval_id,action,actor_id,payload) SELECT ?,?,?,?,? WHERE ${condition}`,
    eventId,
    key,
    action,
    s.userId,
    JSON.stringify(payload),
    ...args,
  );
}
async function points(s: Store, revisionId: string, keys: string[]) {
  if (new Set(keys).size !== keys.length)
    throw new HttpError(400, "Duplicate technical point");
  if (!keys.length) return [];
  const rows = await s.all<{
    id: string;
    number: number;
    title: string;
    page: number;
    revision_id: string;
    document_id: string;
    status: string;
  }>(
    "SELECT id,number,title,page,revision_id,document_id,status FROM review_items WHERE revision_id=? AND is_point=1 AND point_deleted_at IS NULL AND id IN(SELECT value FROM json_each(?))",
    revisionId,
    JSON.stringify(keys),
  );
  if (rows.length !== keys.length)
    throw new HttpError(
      400,
      "Technical points must belong to the exact revision",
    );
  return rows;
}

async function context(
  s: Store,
  project: string,
  message: string | null,
  request: string | null,
) {
  if (message) {
    const m = await s
      .statement(
        "SELECT m.id FROM conversation_messages m JOIN project_conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.project_id=? AND m.deleted_at IS NULL AND (m.shared=1 OR m.author_id=?)",
        message,
        project,
        s.userId,
      )
      .first();
    if (!m)
      throw new HttpError(400, "Source message unavailable in this project");
  }
  if (request) {
    const r = await s
      .statement(
        "SELECT t.id FROM technical_requests t JOIN conversation_messages m ON m.id=t.message_id WHERE t.id=? AND t.project_id=? AND (m.shared=1 OR m.author_id=?)",
        request,
        project,
        s.userId,
      )
      .first();
    if (!r)
      throw new HttpError(400, "Technical request unavailable in this project");
  }
}
async function create(
  s: Store,
  v: z.infer<typeof approvalCreate>,
  previous: string | null = null,
) {
  const r = await revision(s, v.revision_id);
  const pointSnapshot = await points(s, r.id, v.point_ids);
  await context(s, r.project_id, v.message_id, v.technical_request_id);
  const existing = await s
    .statement("SELECT id FROM approval_requests WHERE id=?", v.id)
    .first();
  if (existing) throw new HttpError(409, "Approval identifier already used");
  const g = guard(s, r.project_id);
  const statements = [
    s.statement(
      `INSERT INTO approval_requests(id,project_id,document_id,revision_id,title,description,requester_id,responsible,purpose,priority,due_date,message_id,technical_request_id,previous_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${g.text}`,
      v.id,
      r.project_id,
      r.document_id,
      r.id,
      v.title,
      v.description,
      s.userId,
      v.responsible,
      v.purpose,
      v.priority,
      v.due_date,
      v.message_id,
      v.technical_request_id,
      previous,
      ...g.args,
    ),
    event(s, v.id, previous ? "approval.resubmitted" : "approval.created", {
      ...v,
      point_snapshot: pointSnapshot,
    }),
  ];
  for (const point of v.point_ids)
    statements.push(
      s.statement(
        "INSERT INTO approval_points(approval_id,point_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM approval_requests WHERE id=?)",
        v.id,
        point,
        v.id,
      ),
    );
  if (previous)
    statements.push(
      event(
        s,
        previous,
        "approval.successor_created",
        { successor_id: v.id, revision_id: r.id },
        "EXISTS(SELECT 1 FROM approval_requests WHERE id=?)",
        [v.id],
      ),
    );
  await s.write(statements, r.organization_id, "approval.created", v.id, true);
  return { id: v.id };
}
export function approvalRoutes() {
  const app = new Hono<{ Bindings: Bindings; Variables: Vars }>();
  app.post("/api/v1/approvals", async (c) =>
    c.json(
      await create(
        c.get("store"),
        parse(approvalCreate, await c.req.json().catch(() => null)),
      ),
      201,
    ),
  );
  app.get("/api/v1/projects/:project/approvals", async (c) => {
    const s = c.get("store"),
      project = id(c.req.param("project"));
    await s.requireProject(project, true);
    const status = c.req.query("status")
        ? parse(z.enum(approvalStatuses), c.req.query("status"))
        : "",
      purpose = c.req.query("purpose")
        ? parse(z.enum(approvalPurposes), c.req.query("purpose"))
        : "",
      priority = c.req.query("priority")
        ? parse(z.enum(requestPriorities), c.req.query("priority"))
        : "",
      q = (c.req.query("q") ?? "").slice(0, 200),
      filter = parse(
        z.enum(["", "overdue", "blocking"]),
        c.req.query("filter") ?? "",
      );
    const sort = parse(
      z.enum(["created", "due", "decision", "priority"]),
      c.req.query("sort") ?? "created",
    );
    const order =
      sort === "due"
        ? "a.due_date IS NULL,a.due_date"
        : sort === "decision"
          ? "a.decided_at IS NULL,a.decided_at DESC"
          : sort === "priority"
            ? "CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END"
            : "a.number DESC";
    const rows = await s.all(
      `${select} WHERE a.project_id=? AND a.deleted_at IS NULL AND (a.status<>'draft' OR a.requester_id=?) AND (?='' OR a.status=?) AND (?='' OR a.purpose=?) AND (?='' OR a.priority=?) AND (?='' OR instr(lower(a.title||' '||a.description||' '||d.name||' '||d.number||' '||r.label||' '||a.responsible),lower(?))>0) AND (?='' OR a.revision_id=?) AND (?<>'overdue' OR (a.status='pending' AND a.due_date<?)) AND (?<>'blocking' OR (a.status IN('pending','rejected','changes_requested') AND a.purpose='manufacturing' AND r.ordinal=(SELECT MAX(ordinal) FROM document_revisions WHERE document_id=a.document_id) AND a.id=(SELECT x.id FROM approval_requests x WHERE x.revision_id=a.revision_id AND x.purpose=a.purpose AND x.submitted_at IS NOT NULL AND x.deleted_at IS NULL ORDER BY x.submission_sequence DESC,x.number DESC LIMIT 1))) ORDER BY ${order},a.number DESC LIMIT 31 OFFSET ?`,
      project,
      s.userId,
      status,
      status,
      purpose,
      purpose,
      priority,
      priority,
      q,
      q,
      c.req.query("revision") ? id(c.req.query("revision")) : "",
      c.req.query("revision") ?? "",
      filter,
      today(),
      filter,
      page(c.req.query("page")) * 30,
    );
    return c.json({ items: rows.slice(0, 30), hasMore: rows.length > 30 });
  });
  app.get("/api/v1/projects/:project/approval-summary", async (c) => {
    const s = c.get("store"),
      project = id(c.req.param("project"));
    await s.requireProject(project, true);
    const counts = await s.all<{ status: string; n: number }>(
      "SELECT status,count(*) AS n FROM approval_requests WHERE project_id=? AND deleted_at IS NULL AND (status<>'draft' OR requester_id=?) GROUP BY status",
      project,
      s.userId,
    );
    const totals = await s
      .statement(
        `SELECT sum(CASE WHEN a.status='pending' AND a.due_date<? THEN 1 ELSE 0 END) AS overdue,sum(CASE WHEN a.purpose='manufacturing' AND a.status IN('pending','rejected','changes_requested') AND r.ordinal=(SELECT max(ordinal) FROM document_revisions WHERE document_id=a.document_id) AND a.id=(SELECT x.id FROM approval_requests x WHERE x.revision_id=a.revision_id AND x.purpose=a.purpose AND x.submitted_at IS NOT NULL AND x.deleted_at IS NULL ORDER BY x.submission_sequence DESC,x.number DESC LIMIT 1) THEN 1 ELSE 0 END) AS blocking FROM approval_requests a JOIN document_revisions r ON r.id=a.revision_id WHERE a.project_id=? AND a.deleted_at IS NULL`,
        today(),
        project,
      )
      .first<{ overdue: number; blocking: number }>();
    return c.json({
      ...Object.fromEntries(
        approvalStatuses.map((status) => [
          status,
          counts.find((x) => x.status === status)?.n ?? 0,
        ]),
      ),
      overdue: totals?.overdue ?? 0,
      blocking: totals?.blocking ?? 0,
    });
  });
  app.get("/api/v1/approvals/:id", async (c) => {
    const s = c.get("store"),
      { a } = await row(s, c.req.param("id"));
    const linked = await s.all(
      "SELECT p.id,p.number,p.title,p.page,p.revision_id,p.document_id,p.point_deleted_at,p.status FROM approval_points l JOIN review_items p ON p.id=l.point_id WHERE l.approval_id=? ORDER BY p.number",
      a.id,
    );
    const history = await s.all(
      "SELECT e.id,e.action,e.payload,e.created_at,p.name AS actor FROM approval_events e JOIN profiles p ON p.id=e.actor_id WHERE e.approval_id=? ORDER BY e.sequence DESC LIMIT 31 OFFSET ?",
      a.id,
      page(c.req.query("event_page")) * 30,
    );
    const next = await s
      .statement(
        "SELECT id FROM approval_requests WHERE previous_id=? AND deleted_at IS NULL",
        a.id,
      )
      .first<{ id: string }>();
    return c.json({
      approval: a,
      points: linked,
      events: history.slice(0, 30),
      hasMoreEvents: history.length > 30,
      successor_id: next?.id ?? null,
    });
  });
  app.patch("/api/v1/approvals/:id", async (c) => {
    const s = c.get("store"),
      { a, organization_id } = await row(s, c.req.param("id"));
    if (a.status !== "draft" || a.requester_id !== s.userId)
      throw new HttpError(409, "Only requester can edit an unsubmitted draft");
    const v = parse(
      approvalFields.extend({ version: z.number().int().positive() }),
      await c.req.json().catch(() => null),
    );
    if (v.revision_id !== a.revision_id)
      throw new HttpError(400, "Revision is immutable; create a new request");
    const pointSnapshot = await points(s, a.revision_id, v.point_ids);
    await context(s, a.project_id, v.message_id, v.technical_request_id);
    const oldPoints = await s.all<{ point_id: string }>(
        "SELECT l.point_id,p.id,p.number,p.title,p.page,p.revision_id,p.document_id FROM approval_points l JOIN review_items p ON p.id=l.point_id WHERE l.approval_id=?",
        a.id,
      ),
      g = guard(s, a.project_id);
    const operation = crypto.randomUUID(),
      check = "EXISTS(SELECT 1 FROM approval_events WHERE id=?)";
    const statements = [
      s.statement(
        `UPDATE approval_requests SET title=?,description=?,responsible=?,purpose=?,priority=?,due_date=?,message_id=?,technical_request_id=?,version=version+1,updated_at=${time} WHERE id=? AND version=? AND status='draft' AND ${g.text}`,
        v.title,
        v.description,
        v.responsible,
        v.purpose,
        v.priority,
        v.due_date,
        v.message_id,
        v.technical_request_id,
        a.id,
        v.version,
        ...g.args,
      ),
      event(
        s,
        a.id,
        "approval.draft_edited",
        {
          before: {
            title: a.title,
            description: a.description,
            responsible: a.responsible,
            purpose: a.purpose,
            priority: a.priority,
            due_date: a.due_date,
            point_ids: oldPoints.map((p) => p.point_id),
            point_snapshot: oldPoints,
            message_id: a.message_id,
            technical_request_id: a.technical_request_id,
          },
          after: { ...v, point_snapshot: pointSnapshot },
        },
        "changes()>0",
        [],
        operation,
      ),
      s.statement(
        `DELETE FROM approval_points WHERE approval_id=? AND ${check}`,
        a.id,
        operation,
      ),
    ];
    for (const point of v.point_ids)
      statements.push(
        s.statement(
          `INSERT INTO approval_points(approval_id,point_id) SELECT ?,? WHERE ${check}`,
          a.id,
          point,
          operation,
        ),
      );
    statements.push(
      s.statement(
        "UPDATE approval_requests SET updated_at=updated_at WHERE id=? AND EXISTS(SELECT 1 FROM approval_events WHERE id=?)",
        a.id,
        operation,
      ),
    );
    await s.write(
      statements,
      organization_id,
      "approval.draft_edited",
      a.id,
      true,
    );
    return c.json({ updated: true });
  });
  app.delete("/api/v1/approvals/:id", async (c) => {
    const s = c.get("store"),
      { a, organization_id } = await row(s, c.req.param("id"));
    if (a.status !== "draft" || a.requester_id !== s.userId)
      throw new HttpError(409, "Only an unsubmitted draft can be deleted");
    const v = parse(
        z.object({ version: z.number().int().positive() }),
        await c.req.json().catch(() => null),
      ),
      g = guard(s, a.project_id);
    await s.write(
      [
        s.statement(
          `UPDATE approval_requests SET deleted_at=${time},version=version+1 WHERE id=? AND status='draft' AND version=? AND ${g.text}`,
          a.id,
          v.version,
          ...g.args,
        ),
        event(s, a.id, "approval.draft_deleted", { title: a.title }),
      ],
      organization_id,
      "approval.draft_deleted",
      a.id,
      true,
    );
    return c.json({ deleted: true });
  });
  app.post("/api/v1/approvals/:id/actions", async (c) => {
    const s = c.get("store"),
      { a, organization_id } = await row(s, c.req.param("id")),
      v = parse(approvalAction, await c.req.json().catch(() => null));
    const decision = ["approve", "reject", "request_changes"].includes(
      v.action,
    );
    if (
      (v.action === "submit" && a.status !== "draft") ||
      (decision && a.status !== "pending") ||
      (v.action === "cancel" && a.status === "cancelled")
    )
      throw new HttpError(
        409,
        "Invalid approval transition; historical decisions cannot be overwritten",
      );
    if (v.action === "submit" && a.requester_id !== s.userId)
      throw new HttpError(403, "Only requester submits this draft");
    if (decision && a.approver_id && a.approver_id !== s.userId)
      throw new HttpError(403, "Assigned approver required");
    if (v.point_ids.length && v.action !== "request_changes")
      throw new HttpError(
        400,
        "Add technical points with a changes-requested decision",
      );
    const pointSnapshot = await points(s, a.revision_id, v.point_ids);
    const existing = await s.all<{ point_id: string }>(
      "SELECT point_id FROM approval_points WHERE approval_id=?",
      a.id,
    );
    if (v.action === "submit")
      await points(
        s,
        a.revision_id,
        existing.map((x) => x.point_id),
      );
    const target =
        v.action === "submit"
          ? "pending"
          : v.action === "approve"
            ? "approved"
            : v.action === "reject"
              ? "rejected"
              : v.action === "request_changes"
                ? "changes_requested"
                : "cancelled",
      g = guard(s, a.project_id);
    const operation = crypto.randomUUID();
    const set =
      v.action === "submit"
        ? `,submitted_at=${time}`
        : decision
          ? `,decided_at=${time},decided_by=?,decision_comment=?`
          : "";
    const statements = [
      s.statement(
        `UPDATE approval_requests SET status=?,version=version+1,updated_at=${time}${set} WHERE id=? AND version=? AND status=? AND deleted_at IS NULL AND ${g.text}`,
        target,
        ...(decision ? [s.userId, v.comment] : []),
        a.id,
        v.version,
        a.status,
        ...g.args,
      ),
      event(
        s,
        a.id,
        `approval.${v.action}`,
        {
          from: a.status,
          to: target,
          comment: v.comment,
          point_ids: v.point_ids,
          point_snapshot: pointSnapshot,
          purpose: a.purpose,
          revision_id: a.revision_id,
        },
        "changes()>0",
        [],
        operation,
      ),
    ];
    for (const point of v.point_ids.filter(
      (key) => !existing.some((x) => x.point_id === key),
    ))
      statements.push(
        s.statement(
          `INSERT INTO approval_points(approval_id,point_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM approval_events WHERE id=?)`,
          a.id,
          point,
          operation,
        ),
      );
    if (v.action === "submit")
      statements.push(
        s.statement(
          "UPDATE approval_requests SET submission_sequence=(SELECT sequence FROM approval_events WHERE id=?) WHERE id=? AND EXISTS(SELECT 1 FROM approval_events WHERE id=?)",
          operation,
          a.id,
          operation,
        ),
      );
    await s.write(
      statements,
      organization_id,
      `approval.${v.action}`,
      a.id,
      true,
    );
    return c.json({ updated: true });
  });
  app.post("/api/v1/approvals/:id/resubmit", async (c) => {
    const s = c.get("store"),
      { a } = await row(s, c.req.param("id"));
    if (
      !["approved", "rejected", "changes_requested", "cancelled"].includes(
        a.status,
      )
    )
      throw new HttpError(409, "Only a completed cycle can have a successor");
    const v = parse(approvalCreate, await c.req.json().catch(() => null)),
      r = await revision(s, v.revision_id);
    if (r.document_id !== a.document_id)
      throw new HttpError(400, "A successor must target the same document");
    return c.json(await create(s, v, a.id), 201);
  });
  app.get("/api/v1/revisions/:id/approval-state", async (c) => {
    const s = c.get("store"),
      r = await revision(s, id(c.req.param("id")));
    const latest = await s
      .statement(
        "SELECT id FROM document_revisions WHERE document_id=? ORDER BY ordinal DESC LIMIT 1",
        r.document_id,
      )
      .first<{ id: string }>();
    const effective = await s.all<{
      id: string;
      purpose: string;
      status: Approval["status"];
    }>(
      "SELECT a.id,a.purpose,a.status FROM approval_requests a WHERE a.revision_id=? AND a.submitted_at IS NOT NULL AND a.deleted_at IS NULL AND a.id=(SELECT x.id FROM approval_requests x WHERE x.revision_id=a.revision_id AND x.purpose=a.purpose AND x.submitted_at IS NOT NULL AND x.deleted_at IS NULL ORDER BY x.submission_sequence DESC,x.number DESC LIMIT 1)",
      r.id,
    );
    const review = effective.find((x) => x.purpose === "internal_review"),
      manufacturing = effective.find((x) => x.purpose === "manufacturing"),
      isLatest = latest?.id === r.id;
    const result: RevisionApproval = {
      revision_id: r.id,
      is_latest: isLatest,
      review_status: review?.status ?? "not_submitted",
      manufacturing_status: manufacturing?.status ?? "not_submitted",
      review_request_id: review?.id ?? null,
      manufacturing_request_id: manufacturing?.id ?? null,
      manufacturing_approved: manufacturing?.status === "approved",
      current_manufacturing_ready:
        isLatest && manufacturing?.status === "approved",
      obsolete_for_current:
        !isLatest &&
        (manufacturing?.status === "approved" || review?.status === "approved"),
    };
    return c.json(result);
  });
  app.get("/api/v1/messages/:id/approvals", async (c) => {
    const s = c.get("store"),
      key = id(c.req.param("id"));
    const m = await s
      .statement(
        "SELECT m.id,c.project_id FROM conversation_messages m JOIN project_conversations c ON c.id=m.conversation_id WHERE m.id=? AND (m.shared=1 OR m.author_id=?)",
        key,
        s.userId,
      )
      .first<{ project_id: string }>();
    if (!m) throw new HttpError(404, "Message not found");
    await s.requireProject(m.project_id, true);
    const rows = await s.all(
      `${select} WHERE a.message_id=? AND a.deleted_at IS NULL AND (a.status<>'draft' OR a.requester_id=?) ORDER BY a.number DESC LIMIT 31 OFFSET ?`,
      key,
      s.userId,
      page(c.req.query("page")) * 30,
    );
    return c.json({ items: rows.slice(0, 30), hasMore: rows.length > 30 });
  });
  return app;
}
