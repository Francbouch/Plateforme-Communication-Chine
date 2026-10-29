-- D1 applies each migration transactionally. No demo data and no hard-coded user.
PRAGMA foreign_keys = ON;
CREATE TABLE profiles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 language TEXT NOT NULL DEFAULT 'fr-CA' CHECK(language IN ('fr-CA','en','zh-CN')),
 timezone TEXT NOT NULL DEFAULT 'America/Toronto',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE identity_links (
 provider TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
 user_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
 PRIMARY KEY(provider,issuer,subject)
);
CREATE TABLE organizations (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE organization_memberships (
 organization_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL REFERENCES profiles(id),
 role TEXT NOT NULL CHECK(role IN ('owner','project_admin','designer','supplier_manager','supplier_engineer','reviewer')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), PRIMARY KEY(organization_id,user_id)
);
CREATE TABLE suppliers (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160), country TEXT NOT NULL CHECK(length(country) BETWEEN 2 AND 80),
 language TEXT NOT NULL CHECK(language IN ('fr-CA','en','zh-CN')), contacts TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), UNIQUE(organization_id,id)
);
CREATE TABLE supplier_notes (
 organization_id TEXT NOT NULL, supplier_id TEXT PRIMARY KEY, internal_notes TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(organization_id,supplier_id) REFERENCES suppliers(organization_id,id)
);
CREATE TABLE supplier_memberships (
 organization_id TEXT NOT NULL, supplier_id TEXT NOT NULL, user_id TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), can_invite INTEGER NOT NULL DEFAULT 0 CHECK(can_invite IN(0,1)),
 PRIMARY KEY(supplier_id,user_id),
 FOREIGN KEY(organization_id,supplier_id) REFERENCES suppliers(organization_id,id),
 FOREIGN KEY(organization_id,user_id) REFERENCES organization_memberships(organization_id,user_id)
);
CREATE TABLE projects (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
 code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 40 AND code NOT GLOB '*[^A-Za-z0-9_-]*'),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160), description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(organization_id,id), UNIQUE(organization_id,code)
);
CREATE TABLE project_suppliers (
 organization_id TEXT NOT NULL, project_id TEXT NOT NULL, supplier_id TEXT NOT NULL,
 PRIMARY KEY(project_id,supplier_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,id),
 FOREIGN KEY(organization_id,supplier_id) REFERENCES suppliers(organization_id,id)
);
CREATE TABLE project_memberships (
 organization_id TEXT NOT NULL, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('project_admin','designer','supplier_manager','supplier_engineer','reviewer')),
 supplier_id TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 PRIMARY KEY(project_id,user_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,id),
 FOREIGN KEY(organization_id,user_id) REFERENCES organization_memberships(organization_id,user_id),
 FOREIGN KEY(project_id,supplier_id) REFERENCES project_suppliers(project_id,supplier_id),
 CHECK((role IN('supplier_manager','supplier_engineer')) = (supplier_id IS NOT NULL))
);
CREATE TABLE invitations (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, supplier_id TEXT,
 email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('project_admin','designer','supplier_manager','supplier_engineer','reviewer')),
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), created_by TEXT NOT NULL REFERENCES profiles(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 expires_at TEXT NOT NULL, accepted_at TEXT, revoked_at TEXT,
 FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,id),
 FOREIGN KEY(project_id,supplier_id) REFERENCES project_suppliers(project_id,supplier_id),
 CHECK((role IN('supplier_manager','supplier_engineer')) = (supplier_id IS NOT NULL))
);
CREATE TABLE audit_events (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
 actor_id TEXT NOT NULL REFERENCES profiles(id), action TEXT NOT NULL, resource_id TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE outbox (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
 event_type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), delivered_at TEXT,
 idempotency_key TEXT NOT NULL UNIQUE
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE INDEX org_members_user ON organization_memberships(user_id,active);
CREATE INDEX project_members_user ON project_memberships(user_id,project_id,active);
CREATE INDEX supplier_members_user ON supplier_memberships(user_id,supplier_id,active);
CREATE INDEX projects_recent ON projects(organization_id,updated_at DESC);
CREATE INDEX invitations_recent ON invitations(organization_id,created_at DESC);
CREATE INDEX audit_recent ON audit_events(organization_id,created_at DESC);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE delivered_at IS NULL;
