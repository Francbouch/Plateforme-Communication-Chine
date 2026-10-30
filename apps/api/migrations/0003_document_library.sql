ALTER TABLE projects ADD COLUMN lifecycle_status TEXT CHECK(lifecycle_status IN ('active','paused','completed','archived'));
CREATE TABLE document_folders (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), parent_id TEXT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(project_id,id), FOREIGN KEY(project_id,parent_id) REFERENCES document_folders(project_id,id)
);
CREATE UNIQUE INDEX folder_names ON document_folders(project_id,ifnull(parent_id,''),name COLLATE NOCASE) WHERE archived=0;
CREATE INDEX folders_parent ON document_folders(project_id,parent_id,archived);
CREATE TABLE documents (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), folder_id TEXT,
 number TEXT NOT NULL DEFAULT '' CHECK(length(number)<=80), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200), description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','in_review','to_approve','approved','rejected','archived')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(project_id,id), FOREIGN KEY(project_id,folder_id) REFERENCES document_folders(project_id,id)
);
CREATE INDEX documents_folder ON documents(project_id,folder_id,status,updated_at DESC,id);
CREATE INDEX documents_status ON documents(project_id,status,updated_at DESC,id);
CREATE TABLE document_revisions (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), ordinal INTEGER NOT NULL,
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 40), change_description TEXT NOT NULL DEFAULT '',
 filename TEXT NOT NULL, extension TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0 AND size<=52428800),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), object_key TEXT NOT NULL UNIQUE,
 created_by TEXT NOT NULL REFERENCES profiles(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(document_id,label), UNIQUE(document_id,ordinal)
);
CREATE INDEX revisions_latest ON document_revisions(document_id,ordinal DESC);
CREATE TRIGGER revision_no_update BEFORE UPDATE ON document_revisions BEGIN SELECT RAISE(ABORT,'revisions are immutable'); END;
CREATE TRIGGER revision_no_delete BEFORE DELETE ON document_revisions BEGIN SELECT RAISE(ABORT,'revisions are immutable'); END;
CREATE TABLE document_status_history (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), from_status TEXT, to_status TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES profiles(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX document_history ON document_status_history(document_id,created_at DESC);
CREATE TABLE document_mutation_actor (document_id TEXT PRIMARY KEY REFERENCES documents(id),actor_id TEXT NOT NULL REFERENCES profiles(id));
CREATE TRIGGER document_status_changed AFTER UPDATE OF status ON documents WHEN OLD.status<>NEW.status BEGIN INSERT INTO document_status_history(id,document_id,from_status,to_status,actor_id) VALUES(lower(hex(randomblob(16))),NEW.id,OLD.status,NEW.status,(SELECT actor_id FROM document_mutation_actor WHERE document_id=NEW.id)); END;
CREATE TABLE document_uploads (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), document_id TEXT NOT NULL, revision_id TEXT NOT NULL UNIQUE,
 actor_id TEXT NOT NULL REFERENCES profiles(id), object_key TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL CHECK(json_valid(metadata)),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','completed','cancelled')), expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX uploads_pending ON document_uploads(project_id,actor_id,state,expires_at);
CREATE TRIGGER folder_no_cycle BEFORE UPDATE OF parent_id ON document_folders WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: folder cycle') WHERE NEW.parent_id IN (WITH RECURSIVE tree(id) AS (SELECT OLD.id UNION SELECT f.id FROM document_folders f JOIN tree t ON f.parent_id=t.id) SELECT id FROM tree); END;
CREATE TRIGGER folder_active_parent_insert BEFORE INSERT ON document_folders WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: archived destination') WHERE EXISTS(SELECT 1 FROM document_folders WHERE id=NEW.parent_id AND archived=1); END;
CREATE TRIGGER folder_active_parent_move BEFORE UPDATE OF parent_id ON document_folders WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: archived destination') WHERE EXISTS(SELECT 1 FROM document_folders WHERE id=NEW.parent_id AND archived=1); END;
CREATE TRIGGER document_active_folder_insert BEFORE INSERT ON documents WHEN NEW.folder_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: archived destination') WHERE EXISTS(SELECT 1 FROM document_folders WHERE id=NEW.folder_id AND archived=1); END;
CREATE TRIGGER document_active_folder_move BEFORE UPDATE OF folder_id ON documents WHEN NEW.folder_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: archived destination') WHERE EXISTS(SELECT 1 FROM document_folders WHERE id=NEW.folder_id AND archived=1); END;
CREATE TRIGGER document_history_no_update BEFORE UPDATE ON document_status_history BEGIN SELECT RAISE(ABORT,'document status history is append-only'); END;
CREATE TRIGGER document_history_no_delete BEFORE DELETE ON document_status_history BEGIN SELECT RAISE(ABORT,'document status history is append-only'); END;
