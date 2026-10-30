ALTER TABLE documents ADD COLUMN review_counter INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX revision_document_identity ON document_revisions(document_id,id);
CREATE TABLE review_items (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 number INTEGER NOT NULL CHECK(number>0), page INTEGER NOT NULL CHECK(page BETWEEN 1 AND 10000),
 type TEXT NOT NULL CHECK(type IN('marker','rectangle','arrow','freehand','highlight','text','discussion')),
 color TEXT NOT NULL CHECK(color IN('red','orange','yellow','green','blue')), geometry TEXT NOT NULL CHECK(json_valid(geometry)),
 content TEXT NOT NULL DEFAULT '' CHECK(length(content)<=2000), summary TEXT NOT NULL DEFAULT '' CHECK(length(summary)<=4000),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','in_progress','waiting','resolved')),
 responsible TEXT NOT NULL DEFAULT '' CHECK(length(responsible)<=120),
 created_by TEXT NOT NULL REFERENCES profiles(id), version INTEGER NOT NULL DEFAULT 1,
 annotation_deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(document_id,number), FOREIGN KEY(document_id,revision_id) REFERENCES document_revisions(document_id,id)
);
CREATE INDEX review_page ON review_items(revision_id,page,number);
CREATE INDEX review_points ON review_items(document_id,status,number);
CREATE TABLE review_messages (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES review_items(id), body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
 author_id TEXT NOT NULL REFERENCES profiles(id), version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX review_thread ON review_messages(item_id,created_at,id);
CREATE TABLE review_events (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES review_items(id), actor_id TEXT NOT NULL REFERENCES profiles(id),
 action TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX review_history ON review_events(item_id,created_at,id);
CREATE TRIGGER review_history_no_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT,'review history is append-only'); END;
CREATE TRIGGER review_history_no_delete BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT,'review history is append-only'); END;
CREATE TRIGGER review_identity_immutable BEFORE UPDATE OF document_id,revision_id,number,page,type,created_by ON review_items BEGIN SELECT RAISE(ABORT,'review identity is immutable'); END;
CREATE TRIGGER review_no_delete BEFORE DELETE ON review_items BEGIN SELECT RAISE(ABORT,'review references are preserved'); END;
