-- Additive and fail-closed: all old content remains internal. Activation is a separate reviewed setting.
ALTER TABLE profiles ADD COLUMN auth_not_before INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_memberships ADD COLUMN access_enabled INTEGER NOT NULL DEFAULT 0 CHECK(access_enabled IN(0,1));
ALTER TABLE project_memberships ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(permissions));
ALTER TABLE project_memberships ADD COLUMN access_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE project_memberships ADD COLUMN added_at TEXT NOT NULL DEFAULT ('' );
ALTER TABLE documents ADD COLUMN externally_shared INTEGER NOT NULL DEFAULT 0 CHECK(externally_shared IN(0,1));
ALTER TABLE project_conversations ADD COLUMN externally_shared INTEGER NOT NULL DEFAULT 0 CHECK(externally_shared IN(0,1));
ALTER TABLE approval_requests ADD COLUMN externally_shared INTEGER NOT NULL DEFAULT 0 CHECK(externally_shared IN(0,1));
ALTER TABLE approval_requests ADD COLUMN decision_identity TEXT CHECK(decision_identity IS NULL OR json_valid(decision_identity));
CREATE TABLE revision_shares (
 revision_id TEXT PRIMARY KEY REFERENCES document_revisions(id), shared_by TEXT NOT NULL REFERENCES profiles(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE revoked_sessions (session_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES profiles(id));
CREATE INDEX revoked_sessions_user ON revoked_sessions(user_id,expires_at);
CREATE TABLE access_invitations (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),email TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN('project_admin','designer','supplier_engineer','reviewer')),supplier_id TEXT REFERENCES suppliers(id),
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),message TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL REFERENCES profiles(id),
 acceptance_key TEXT, expires_at TEXT NOT NULL,accepted_at TEXT,accepted_by TEXT REFERENCES profiles(id),revoked_at TEXT,
 delivery TEXT NOT NULL DEFAULT 'not_configured' CHECK(delivery IN('not_configured','pending','sent','failed')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((role='supplier_engineer')=(supplier_id IS NOT NULL))
);
CREATE INDEX access_invite_email ON access_invitations(email,expires_at);
CREATE TABLE access_invitation_projects (
 invitation_id TEXT NOT NULL REFERENCES access_invitations(id),project_id TEXT NOT NULL REFERENCES projects(id),
 PRIMARY KEY(invitation_id,project_id)
);
CREATE TABLE security_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,organization_id TEXT REFERENCES organizations(id),
 actor_id TEXT REFERENCES profiles(id),action TEXT NOT NULL,resource_id TEXT,payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX security_events_org ON security_events(organization_id,sequence DESC);
CREATE TRIGGER security_no_update BEFORE UPDATE ON security_events BEGIN SELECT RAISE(ABORT,'Security history is append-only'); END;
CREATE TRIGGER security_no_delete BEFORE DELETE ON security_events BEGIN SELECT RAISE(ABORT,'Security history is append-only'); END;

CREATE TABLE observed_sessions (session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES profiles(id),expires_at INTEGER NOT NULL);

CREATE TRIGGER approval_decision_identity_immutable BEFORE UPDATE OF decision_identity ON approval_requests WHEN OLD.decided_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Decision identity is immutable'); END;
