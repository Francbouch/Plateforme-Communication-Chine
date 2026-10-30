import type {
  Approval,
  ApprovalDetail,
  RevisionApproval,
} from "../packages/shared/src/approvals";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { migrate } from "./helpers/d1";
const admin = "00000000-0000-4000-8000-000000000001",
  origin = "https://workspace.example.test",
  issuer = "https://approval-test.cloudflareaccess.com";
let persistence: string;
let script: string,
  token: string,
  runtime: Miniflare,
  db: D1Database,
  storage: R2Bucket,
  org: string,
  project: string;
beforeAll(async () => {
  const key = await generateKeyPair("RS256"),
    jwk = await exportJWK(key.publicKey);
  token = await new SignJWT({ email: "library@example.test", type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience("library")
    .setSubject("library-owner")
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(key.privateKey);
  const result = await build({
    stdin: {
      contents: `import {createApp} from './apps/api/src/index';import {AccessIdentityProvider} from './apps/api/src/identity';import {createLocalJWKSet} from 'jose';export default createApp(new AccessIdentityProvider(createLocalJWKSet({keys:[${JSON.stringify({ ...jwk, kid: "test", alg: "RS256" })}]})));`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  script = result.outputFiles[0].text;
});
async function req(
  path: string,
  body?: unknown,
  method?: string,
  headers: Record<string, string> = {},
) {
  return runtime.dispatchFetch(`${origin}/api/v1/${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      Origin: origin,
      "Cf-Access-Jwt-Assertion": token,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json<T>(response: Awaited<ReturnType<typeof req>>): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBeLessThan(300);
  return JSON.parse(text) as T;
}
function makeRuntime() {
  return new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: persistence,
      modules: true,
      script,
      compatibilityDate: "2026-10-29",
      d1Databases: { DB: "approval-test" },
      r2Buckets: { DOCUMENTS: "approval-files" },
      bindings: {
        APP_ORIGIN: origin,
        ACCESS_ISSUER: issuer,
        ACCESS_AUD: "library",
        ADMIN_EMAIL: "library@example.test",
        ADMIN_USER_ID: admin,
      },
    }),
  );
}
beforeEach(async () => {
  persistence = await mkdtemp(join(tmpdir(), "forgebridge-approval-test-"));
  runtime = makeRuntime();
  db = (await runtime.getD1Database("DB")) as unknown as D1Database;
  storage = (await runtime.getR2Bucket("DOCUMENTS")) as unknown as R2Bucket;
  await migrate(db);
  org = (
    await json<{ id: string }>(
      await req("organizations", { name: "Approval test" }),
    )
  ).id;
  project = (
    await json<{ id: string }>(
      await req("projects", {
        organization_id: org,
        code: "LIB",
        name: "Library project",
      }),
    )
  ).id;
});
afterEach(async () => {
  await runtime.dispose();
  await rm(persistence, { recursive: true, force: true });
});
const bytes = new TextEncoder().encode(
  "%PDF-1.7\nnon confidential test file\n%%EOF",
);
async function reserve(extra: Record<string, unknown> = {}) {
  const sha256 = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  return json<{ id: string; document_id: string }>(
    await req(`projects/${project}/uploads`, {
      name: "Mechanism",
      number: "LC-001",
      filename: "plan.pdf",
      size: bytes.byteLength,
      sha256,
      ...extra,
    }),
  );
}
async function content(id: string, data: Uint8Array = bytes) {
  return runtime.dispatchFetch(`${origin}/api/v1/uploads/${id}/content`, {
    method: "PUT",
    headers: {
      Origin: origin,
      "Cf-Access-Jwt-Assertion": token,
      "Content-Length": String(data.byteLength),
    },
    body: Buffer.from(data),
  });
}
async function complete(id: string) {
  return json<{ id: string; revision_id: string }>(
    await req(`uploads/${id}/complete`, {}),
  );
}
async function document(label = "A") {
  const u = await reserve({ label });
  expect((await content(u.id)).status).toBe(200);
  return complete(u.id);
}
async function nextRevision(documentId: string, label: string) {
  const u = await reserve({ document_id: documentId, label });
  await content(u.id);
  return complete(u.id);
}
async function draft(revisionId: string, extra: Record<string, unknown> = {}) {
  return json<{ id: string }>(
    await req("approvals", {
      id: crypto.randomUUID(),
      revision_id: revisionId,
      title: "Validation before prototype",
      ...extra,
    }),
  );
}
async function detail(key: string) {
  return json<ApprovalDetail>(await req(`approvals/${key}`));
}
async function action(
  key: string,
  value: string,
  comment = "",
  extra: Record<string, unknown> = {},
) {
  const d = await detail(key);
  return req(`approvals/${key}/actions`, {
    version: d.approval.version,
    action: value,
    comment,
    ...extra,
  });
}
async function state(key: string) {
  return json<RevisionApproval>(await req(`revisions/${key}/approval-state`));
}
async function point(doc: string, revision: string, page = 1) {
  const key = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO review_items(id,document_id,revision_id,number,page,type,color,geometry,created_by,is_point,title) VALUES(?,?,?,(SELECT COALESCE(MAX(number),0)+1 FROM review_items WHERE document_id=?),?,'discussion','red','{}',?,1,'Existing correction')",
    )
    .bind(key, doc, revision, doc, page, admin)
    .run();
  return key;
}
describe("internal revision approvals on real D1/R2", () => {
  it("submits and approves exactly revision B, persists after restart and never approves new C", async () => {
    const a = await document(),
      b = await nextRevision(a.id, "B");
    const approval = await draft(b.revision_id, { purpose: "manufacturing" });
    expect((await state(b.revision_id)).manufacturing_status).toBe(
      "not_submitted",
    );
    expect((await action(approval.id, "submit")).status).toBe(200);
    expect(
      (
        await action(
          approval.id,
          "approve",
          "Prototype fabrication internally approved",
        )
      ).status,
    ).toBe(200);
    const approved = await detail(approval.id);
    expect(approved.approval.decided_by).toBe(admin);
    expect(approved.approval.revision_id).toBe(b.revision_id);
    expect(approved.approval.decided_at).toBeTruthy();
    expect((await state(b.revision_id)).current_manufacturing_ready).toBe(true);
    const objects = await storage.list();
    const objectKeys = objects.objects.map((o) => o.key);
    const originals = await Promise.all(
      objectKeys.map((key) => storage.get(key).then((r) => r!.arrayBuffer())),
    );
    await runtime.dispose();
    runtime = makeRuntime();
    db = (await runtime.getD1Database("DB")) as unknown as D1Database;
    storage = (await runtime.getR2Bucket("DOCUMENTS")) as unknown as R2Bucket;
    expect((await detail(approval.id)).approval.status).toBe("approved");
    const c = await nextRevision(a.id, "C");
    expect((await state(c.revision_id)).manufacturing_status).toBe(
      "not_submitted",
    );
    expect((await state(c.revision_id)).manufacturing_approved).toBe(false);
    const historical = await state(b.revision_id);
    expect(historical.manufacturing_approved).toBe(true);
    expect(historical.current_manufacturing_ready).toBe(false);
    expect(historical.obsolete_for_current).toBe(true);
    for (let i = 0; i < objectKeys.length; i++)
      expect(
        Buffer.compare(
          Buffer.from(await (await storage.get(objectKeys[i]))!.arrayBuffer()),
          Buffer.from(originals[i]),
        ),
      ).toBe(0);
    expect(
      (
        await json<{ document: { status: string } }>(
          await req(`documents/${a.id}`),
        )
      ).document.status,
    ).toBe("draft");
  });
  it("requires rejection/change/cancellation reasons, freezes submitted metadata and preserves final decisions on cancellation", async () => {
    const d = await document(),
      a = await draft(d.revision_id);
    expect((await action(a.id, "approve")).status).toBe(409);
    await action(a.id, "submit");
    for (const name of ["reject", "request_changes", "cancel"])
      expect((await action(a.id, name)).status).toBe(400);
    expect(
      (
        await req(
          `approvals/${a.id}`,
          { revision_id: d.revision_id, title: "Silent edit", version: 2 },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(
      (await req(`approvals/${a.id}`, { version: 2 }, "DELETE")).status,
    ).toBe(409);
    expect(
      (await action(a.id, "reject", "Tolerance exceeds specification")).status,
    ).toBe(200);
    expect(
      (await action(a.id, "approve", "Overwrite refused decision")).status,
    ).toBe(409);
    const before = await detail(a.id);
    await action(a.id, "cancel", "Recorded against wrong review cycle");
    const after = await detail(a.id);
    expect(after.approval.status).toBe("cancelled");
    expect(after.approval.decision_comment).toBe(
      before.approval.decision_comment,
    );
    expect(after.approval.decided_at).toBe(before.approval.decided_at);
    expect(
      after.events.some(
        (e) =>
          e.action === "approval.reject" &&
          JSON.parse(e.payload).comment === "Tolerance exceeds specification",
      ),
    ).toBe(true);
    expect(after.events.some((e) => e.action === "approval.cancel")).toBe(true);
    expect((await action(a.id, "submit")).status).toBe(409);
  });
  it("edits draft references atomically and a stale update cannot remove or add another edit’s points", async () => {
    const d = await document(),
      p = await point(d.id, d.revision_id),
      q = await point(d.id, d.revision_id),
      r = await point(d.id, d.revision_id);
    const a = await draft(d.revision_id, { point_ids: [p] });
    const edit = {
      revision_id: d.revision_id,
      title: "Updated draft",
      version: 1,
      point_ids: [q],
    };
    expect((await req(`approvals/${a.id}`, edit, "PATCH")).status).toBe(200);
    const before = (await detail(a.id)).events.length;
    expect(
      (await req(`approvals/${a.id}`, { ...edit, point_ids: [r] }, "PATCH"))
        .status,
    ).toBe(409);
    const current = await detail(a.id);
    expect(current.points.map((p) => p.id)).toEqual([q]);
    expect(current.events).toHaveLength(before);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM audit_events WHERE action='approval.draft_edited' AND resource_id=?",
          )
          .bind(a.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await req(
          `approvals/${a.id}`,
          { ...edit, version: 2, point_ids: [] },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    expect((await detail(a.id)).points).toHaveLength(0);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM audit_events WHERE action='approval.draft_edited' AND resource_id=?",
          )
          .bind(a.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it("links several exact-revision points and never resolves them when approving", async () => {
    const d = await document(),
      b = await nextRevision(d.id, "B"),
      p = await point(d.id, b.revision_id),
      q = await point(d.id, b.revision_id),
      old = await point(d.id, d.revision_id);
    expect(
      (
        await req("approvals", {
          id: crypto.randomUUID(),
          revision_id: b.revision_id,
          title: "Wrong revision",
          point_ids: [old],
        })
      ).status,
    ).toBe(400);
    const a = await draft(b.revision_id, { point_ids: [p] });
    await action(a.id, "submit");
    expect(
      (
        await action(
          a.id,
          "request_changes",
          "Move hole and reduce tolerance",
          { point_ids: [q] },
        )
      ).status,
    ).toBe(200);
    expect((await detail(a.id)).points.map((p) => p.id).sort()).toEqual(
      [p, q].sort(),
    );
    const successor = await json<{ id: string }>(
      await req(`approvals/${a.id}/resubmit`, {
        id: crypto.randomUUID(),
        revision_id: b.revision_id,
        title: "Corrected review",
        point_ids: [p, q],
      }),
    );
    await action(successor.id, "submit");
    await action(successor.id, "approve");
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM review_items WHERE id IN(?,?) AND status='open'",
          )
          .bind(p, q)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
    expect((await detail(a.id)).approval.status).toBe("changes_requested");
    expect((await detail(a.id)).successor_id).toBe(successor.id);
  });
  it("cancelling a newer cycle does not silently resurrect an older manufacturing approval", async () => {
    const d = await document(),
      a = await draft(d.revision_id, { purpose: "manufacturing" });
    await action(a.id, "submit");
    await action(a.id, "approve");
    const b = await json<{ id: string }>(
      await req(`approvals/${a.id}/resubmit`, {
        id: crypto.randomUUID(),
        revision_id: d.revision_id,
        title: "Explicit reassessment",
        purpose: "manufacturing",
      }),
    );
    await action(b.id, "submit");
    expect((await state(d.revision_id)).current_manufacturing_ready).toBe(
      false,
    );
    await action(b.id, "cancel", "Pending additional engineering data");
    const current = await state(d.revision_id);
    expect(current.manufacturing_status).toBe("cancelled");
    expect(current.manufacturing_approved).toBe(false);
    expect((await detail(a.id)).approval.status).toBe("approved");
  });
  it("separates review-purpose approval, documentary status and manufacturing readiness", async () => {
    const d = await document();
    await req(
      `documents/${d.id}`,
      { name: "Mechanism", status: "approved" },
      "PATCH",
    );
    expect((await state(d.revision_id)).manufacturing_approved).toBe(false);
    const a = await draft(d.revision_id);
    await action(a.id, "submit");
    await action(a.id, "approve");
    const current = await state(d.revision_id);
    expect(current.review_status).toBe("approved");
    expect(current.current_manufacturing_ready).toBe(false);
  });
  it("records source discussions and existing technical requests without duplicating either system", async () => {
    const d = await document();
    const conversation = await json<{ id: string }>(
      await req(`projects/${project}/conversations`, {
        title: "Review context",
      }),
    );
    const m = await json<{ id: string }>(
      await req(`conversations/${conversation.id}/messages`, {
        id: crypto.randomUUID(),
        body: "Looks good",
      }),
    );
    expect((await state(d.revision_id)).review_status).toBe("not_submitted");
    const t = await json<{ id: string }>(
      await req(`messages/${m.id}/requests`, { title: "Existing action item" }),
    );
    const a = await draft(d.revision_id, {
      message_id: m.id,
      technical_request_id: t.id,
    });
    await action(a.id, "submit");
    await action(a.id, "approve");
    const linked = await json<{ items: Approval[] }>(
      await req(`messages/${m.id}/approvals`),
    );
    expect(linked.items[0].id).toBe(a.id);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM technical_requests")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect((await detail(a.id)).approval.conversation_id).toBe(conversation.id);
    const source = await json<{ id: string }>(
      await req(`conversations/${conversation.id}/messages`, {
        id: crypto.randomUUID(),
        body: "Source without task",
      }),
    );
    await draft(d.revision_id, { message_id: source.id });
    expect(
      (await req(`messages/${source.id}`, { version: 1 }, "DELETE")).status,
    ).toBe(409);
  });
  it("derives paginated filters and statistics from D1, with blocking limited to the current manufacturing revision", async () => {
    const d = await document(),
      b = await nextRevision(d.id, "B");
    const old = await draft(d.revision_id, { purpose: "manufacturing" });
    await action(old.id, "submit");
    await action(old.id, "reject", "Historic refusal");
    const pending = await draft(b.revision_id, {
      purpose: "manufacturing",
      due_date: "2000-01-01",
      priority: "critical",
      title: "Current production gate",
    });
    await action(pending.id, "submit");
    const review = await draft(b.revision_id);
    await action(review.id, "submit");
    await action(review.id, "request_changes", "Clarify technical note");
    const summary = await json<Record<string, number>>(
      await req(`projects/${project}/approval-summary`),
    );
    expect(summary.pending).toBe(1);
    expect(summary.changes_requested).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.overdue).toBe(1);
    expect(summary.blocking).toBe(1);
    for (const query of [
      "filter=overdue",
      "filter=blocking",
      "q=production&priority=critical&status=pending",
      "revision=" + b.revision_id + "&purpose=manufacturing&sort=due",
    ]) {
      const rows = await json<{ items: Approval[] }>(
        await req(`projects/${project}/approvals?${query}`),
      );
      expect(rows.items.map((r) => r.id)).toEqual([pending.id]);
    }
    const before = (await storage.list()).objects.length;
    await req(`projects/${project}/approval-summary`);
    expect((await storage.list()).objects).toHaveLength(before);
    expect(
      (await req(`projects/${project}/approvals?sort=sql-injection`)).status,
    ).toBe(400);
  });
  it("rejects stale decisions, keeps event failures atomic and enforces append-only records in SQLite", async () => {
    const d = await document(),
      a = await draft(d.revision_id);
    await action(a.id, "submit");
    const extraPoint = await point(d.id, d.revision_id);
    expect(
      (
        await req(`approvals/${a.id}/actions`, {
          version: 1,
          action: "request_changes",
          comment: "Stale decision",
          point_ids: [extraPoint],
        })
      ).status,
    ).toBe(409);
    expect((await detail(a.id)).points).toHaveLength(0);
    await db
      .prepare(
        "CREATE TRIGGER fail_approval_event BEFORE INSERT ON approval_events WHEN NEW.action='approval.approve' BEGIN SELECT RAISE(ABORT,'simulated history failure'); END",
      )
      .run();
    expect((await action(a.id, "approve")).status).toBe(503);
    expect((await detail(a.id)).approval.status).toBe("pending");
    await db.prepare("DROP TRIGGER fail_approval_event").run();
    const version = (await detail(a.id)).approval.version;
    await action(a.id, "approve");
    expect(
      (
        await req(`approvals/${a.id}/actions`, {
          version,
          action: "reject",
          comment: "Concurrent edit",
        })
      ).status,
    ).toBe(409);
    await expect(
      db
        .prepare("UPDATE approval_requests SET decision_comment=? WHERE id=?")
        .bind("Silent rewrite", a.id)
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      db
        .prepare("UPDATE approval_requests SET revision_id=? WHERE id=?")
        .bind(crypto.randomUUID(), a.id)
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      db
        .prepare("DELETE FROM approval_events WHERE approval_id=?")
        .bind(a.id)
        .run(),
    ).rejects.toThrow("append-only");
    await expect(
      db.prepare("DELETE FROM approval_requests WHERE id=?").bind(a.id).run(),
    ).rejects.toThrow("preserved");
  });
  it("deletes only drafts, permits replacing a deleted successor draft, and prevents duplicate pending cycles", async () => {
    const d = await document(),
      a = await draft(d.revision_id),
      b = await draft(d.revision_id);
    await action(a.id, "submit");
    expect((await action(b.id, "submit")).status).toBe(409);
    await action(a.id, "approve");
    const successor = await json<{ id: string }>(
      await req(`approvals/${a.id}/resubmit`, {
        id: crypto.randomUUID(),
        revision_id: d.revision_id,
        title: "Unused successor",
      }),
    );
    expect(
      (await req(`approvals/${successor.id}`, { version: 1 }, "DELETE")).status,
    ).toBe(200);
    expect((await req(`approvals/${successor.id}`)).status).toBe(404);
    expect(
      (
        await req(`approvals/${a.id}/resubmit`, {
          id: crypto.randomUUID(),
          revision_id: d.revision_id,
          title: "Replacement successor",
        })
      ).status,
    ).toBe(201);
  });
  it("enforces project, requester, approver, private-message and Origin authorization", async () => {
    const d = await document(),
      a = await draft(d.revision_id);
    expect(
      (await runtime.dispatchFetch(`${origin}/api/v1/approvals/${a.id}`))
        .status,
    ).toBe(401);
    expect(
      (
        await req(
          `approvals/${a.id}/actions`,
          { version: 1, action: "submit" },
          "POST",
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    const foreign = crypto.randomUUID();
    await db
      .prepare("INSERT INTO profiles(id,name) VALUES(?,?)")
      .bind(foreign, "Other isolated reviewer")
      .run();
    await db
      .prepare("UPDATE approval_requests SET approver_id=? WHERE id=?")
      .bind(foreign, a.id)
      .run();
    await action(a.id, "submit");
    expect((await action(a.id, "approve")).status).toBe(403);
    const draftForeign = await draft(d.revision_id);
    await db
      .prepare("UPDATE profiles SET status='suspended' WHERE id=?")
      .bind(admin)
      .run();
    expect((await req(`approvals/${draftForeign.id}`)).status).toBe(403);
  });
  it("paginates register and history, and freezes human-readable point snapshots", async () => {
    const d = await document(),
      p = await point(d.id, d.revision_id),
      a = await draft(d.revision_id, { point_ids: [p] });
    await db
      .prepare("UPDATE review_items SET title=? WHERE id=?")
      .bind("Renamed later", p)
      .run();
    const history = (await detail(a.id)).events;
    expect(JSON.parse(history[0].payload).point_snapshot[0].title).toBe(
      "Existing correction",
    );
    await db.batch(
      Array.from({ length: 34 }, (_, n) =>
        db
          .prepare(
            "INSERT INTO approval_requests(id,project_id,document_id,revision_id,title,requester_id) VALUES(?,?,?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            project,
            d.id,
            d.revision_id,
            `Paged request ${n}`,
            admin,
          ),
      ),
    );
    const first = await json<{ items: Approval[]; hasMore: boolean }>(
        await req(`projects/${project}/approvals`),
      ),
      second = await json<{ items: Approval[] }>(
        await req(`projects/${project}/approvals?page=1`),
      );
    expect(first.items).toHaveLength(30);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(5);
    expect(
      new Set([...first.items, ...second.items].map((a) => a.id)).size,
    ).toBe(35);
    await db.batch(
      Array.from({ length: 34 }, () =>
        db
          .prepare(
            "INSERT INTO approval_events(id,approval_id,action,actor_id,payload) VALUES(?,?,?,?,'{}')",
          )
          .bind(crypto.randomUUID(), a.id, "test.trace", admin),
      ),
    );
    expect((await detail(a.id)).hasMoreEvents).toBe(true);
    expect((await detail(a.id)).events).toHaveLength(30);
    expect(
      (await json<ApprovalDetail>(await req(`approvals/${a.id}?event_page=1`)))
        .events,
    ).toHaveLength(5);
  });
  it("rejects cross-project source context and revisions in an inaccessible organization", async () => {
    const d = await document(),
      foreignOrg = crypto.randomUUID(),
      foreignProject = crypto.randomUUID(),
      foreignDocument = crypto.randomUUID(),
      foreignRevision = crypto.randomUUID(),
      conversation = crypto.randomUUID(),
      messageId = crypto.randomUUID();
    await db
      .prepare("INSERT INTO organizations(id,name) VALUES(?,?)")
      .bind(foreignOrg, "Other isolated organization")
      .run();
    await db
      .prepare(
        "INSERT INTO projects(id,organization_id,code,name) VALUES(?,?,?,?)",
      )
      .bind(foreignProject, foreignOrg, "FOREIGN", "Other project")
      .run();
    await db
      .prepare("INSERT INTO documents(id,project_id,name) VALUES(?,?,?)")
      .bind(foreignDocument, foreignProject, "Other document")
      .run();
    await db
      .prepare(
        "INSERT INTO document_revisions(id,document_id,ordinal,label,filename,extension,content_type,size,sha256,object_key,created_by) SELECT ?,?,1,'A',filename,extension,content_type,size,sha256,?,created_by FROM document_revisions WHERE id=?",
      )
      .bind(
        foreignRevision,
        foreignDocument,
        "isolated/not-uploaded",
        d.revision_id,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO project_conversations(id,project_id,title,created_by) VALUES(?,?,?,?)",
      )
      .bind(conversation, foreignProject, "Other context", admin)
      .run();
    await db
      .prepare(
        "INSERT INTO conversation_messages(id,conversation_id,author_id,body) VALUES(?,?,?,?)",
      )
      .bind(messageId, conversation, admin, "Other project source")
      .run();
    expect(
      (
        await req("approvals", {
          id: crypto.randomUUID(),
          revision_id: foreignRevision,
          title: "Forbidden",
        })
      ).status,
    ).toBe(403);
    expect(
      (await req(`revisions/${foreignRevision}/approval-state`)).status,
    ).toBe(403);
    expect(
      (await req(`projects/${foreignProject}/approval-summary`)).status,
    ).toBe(403);
    expect(
      (
        await req("approvals", {
          id: crypto.randomUUID(),
          revision_id: d.revision_id,
          title: "Wrong context",
          message_id: messageId,
        })
      ).status,
    ).toBe(400);
  });
  it("orders submissions by immutable events even when timestamps match and drafts were created out of order", async () => {
    const d = await document(),
      old = await draft(d.revision_id, { purpose: "manufacturing" }),
      newer = await draft(d.revision_id, { purpose: "manufacturing" });
    for (const key of [newer.id, old.id]) {
      await db
        .prepare(
          "UPDATE approval_requests SET status='pending',submitted_at='2026-10-30T12:00:00.000Z' WHERE id=?",
        )
        .bind(key)
        .run();
      const event = crypto.randomUUID();
      await db
        .prepare(
          "INSERT INTO approval_events(id,approval_id,action,actor_id,payload) VALUES(?,?,'approval.submit',?,'{}')",
        )
        .bind(event, key, admin)
        .run();
      await db
        .prepare(
          "UPDATE approval_requests SET submission_sequence=(SELECT sequence FROM approval_events WHERE id=?) WHERE id=?",
        )
        .bind(event, key)
        .run();
      await db
        .prepare(
          "UPDATE approval_requests SET status='approved',decided_at='2026-10-30T12:01:00.000Z',decided_by=? WHERE id=?",
        )
        .bind(admin, key)
        .run();
    }
    expect((await state(d.revision_id)).manufacturing_request_id).toBe(old.id);
    await expect(
      db
        .prepare(
          "UPDATE approval_requests SET submission_sequence=NULL WHERE id=?",
        )
        .bind(old.id)
        .run(),
    ).rejects.toThrow("immutable");
  });
});
