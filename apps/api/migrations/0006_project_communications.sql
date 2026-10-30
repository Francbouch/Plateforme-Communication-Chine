CREATE TABLE project_conversations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 audience TEXT NOT NULL DEFAULT 'internal' CHECK(audience='internal'),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
 created_by TEXT NOT NULL REFERENCES profiles(id), version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(project_id,id)
);
CREATE INDEX conversations_project ON project_conversations(project_id,archived,updated_at DESC,id);
CREATE TABLE conversation_messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES project_conversations(id),
 parent_id TEXT, author_id TEXT NOT NULL REFERENCES profiles(id),
 body TEXT NOT NULL DEFAULT '' CHECK(length(body)<=8000),
 shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1, deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(conversation_id,id), FOREIGN KEY(conversation_id,parent_id) REFERENCES conversation_messages(conversation_id,id)
);
CREATE INDEX messages_chronology ON conversation_messages(conversation_id,parent_id,created_at DESC,id DESC);
CREATE TRIGGER message_one_reply_level BEFORE INSERT ON conversation_messages WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'Only one reply level') WHERE NOT EXISTS(SELECT 1 FROM conversation_messages WHERE id=NEW.parent_id AND conversation_id=NEW.conversation_id AND parent_id IS NULL AND deleted_at IS NULL); END;
CREATE TRIGGER message_identity_immutable BEFORE UPDATE OF id,conversation_id,parent_id,author_id,created_at ON conversation_messages BEGIN SELECT RAISE(ABORT,'Message identity is immutable'); END;
CREATE TABLE message_references (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES conversation_messages(id),
 document_id TEXT REFERENCES documents(id), revision_id TEXT REFERENCES document_revisions(id),
 point_id TEXT REFERENCES review_items(id), page INTEGER CHECK(page BETWEEN 1 AND 10000),
 CHECK(revision_id IS NULL OR document_id IS NOT NULL), CHECK(point_id IS NULL OR revision_id IS NOT NULL),
 CHECK(page IS NULL OR revision_id IS NOT NULL)
);
CREATE INDEX message_refs_message ON message_references(message_id);
CREATE INDEX message_refs_document ON message_references(document_id,revision_id,message_id);
CREATE TABLE message_attachments (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES project_conversations(id),
 message_id TEXT REFERENCES conversation_messages(id), author_id TEXT NOT NULL REFERENCES profiles(id),
 filename TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 10485760),
 extension TEXT NOT NULL, content_type TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 object_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','ready','attached','cancelled')),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX message_files_message ON message_attachments(message_id);
CREATE INDEX message_files_pending ON message_attachments(conversation_id,author_id,state,expires_at);
CREATE TABLE technical_requests (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 message_id TEXT NOT NULL UNIQUE REFERENCES conversation_messages(id),
 point_id TEXT UNIQUE REFERENCES review_items(id),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), description TEXT NOT NULL DEFAULT '',
 responsible TEXT NOT NULL DEFAULT '', assignee_id TEXT REFERENCES profiles(id), due_date TEXT,
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN('low','normal','high','critical')),
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN('todo','in_progress','waiting','done','cancelled')),
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES profiles(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX technical_requests_project ON technical_requests(project_id,status,priority,updated_at DESC,id);
CREATE TABLE communication_events (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 resource_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES profiles(id),
 action TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX communication_history ON communication_events(resource_id,created_at,id);
CREATE TRIGGER communication_no_update BEFORE UPDATE ON communication_events BEGIN SELECT RAISE(ABORT,'Communication history is append-only'); END;
CREATE TRIGGER communication_no_delete BEFORE DELETE ON communication_events BEGIN SELECT RAISE(ABORT,'Communication history is append-only'); END;
CREATE TRIGGER message_no_hard_delete BEFORE DELETE ON conversation_messages BEGIN SELECT RAISE(ABORT,'Messages retain their history'); END;
CREATE TRIGGER message_sharing_monotonic BEFORE UPDATE OF shared ON conversation_messages WHEN OLD.shared=1 AND NEW.shared=0 BEGIN SELECT RAISE(ABORT,'Shared decisions remain shared'); END;
CREATE TRIGGER request_source_immutable BEFORE UPDATE OF id,project_id,message_id,point_id,created_by,created_at ON technical_requests BEGIN SELECT RAISE(ABORT,'Request source is immutable'); END;
