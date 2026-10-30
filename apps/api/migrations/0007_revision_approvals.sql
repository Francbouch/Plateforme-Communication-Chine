CREATE TABLE approval_requests (
 number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL REFERENCES projects(id), document_id TEXT NOT NULL REFERENCES documents(id),
 revision_id TEXT NOT NULL REFERENCES document_revisions(id),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=8000),
 requester_id TEXT NOT NULL REFERENCES profiles(id), approver_id TEXT REFERENCES profiles(id), responsible TEXT NOT NULL DEFAULT '',
 purpose TEXT NOT NULL DEFAULT 'internal_review' CHECK(purpose IN('internal_review','manufacturing')),
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN('low','normal','high','critical')),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','pending','approved','rejected','changes_requested','cancelled')),
 due_date TEXT, version INTEGER NOT NULL DEFAULT 1,
 message_id TEXT REFERENCES conversation_messages(id), technical_request_id TEXT REFERENCES technical_requests(id),
 previous_id TEXT REFERENCES approval_requests(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 submitted_at TEXT, submission_sequence INTEGER UNIQUE, decided_at TEXT, decided_by TEXT REFERENCES profiles(id), decision_comment TEXT NOT NULL DEFAULT '', deleted_at TEXT,
 FOREIGN KEY(document_id,revision_id) REFERENCES document_revisions(document_id,id)
);
CREATE INDEX approvals_project ON approval_requests(project_id,status,created_at DESC,number DESC);
CREATE INDEX approvals_due ON approval_requests(project_id,status,due_date);
CREATE INDEX approvals_revision ON approval_requests(revision_id,purpose,submission_sequence DESC,number DESC);
CREATE INDEX approvals_message ON approval_requests(message_id,number DESC);
CREATE INDEX approvals_request ON approval_requests(technical_request_id);
CREATE UNIQUE INDEX approval_one_pending ON approval_requests(revision_id,purpose) WHERE status='pending' AND deleted_at IS NULL;
CREATE TABLE approval_points (
 approval_id TEXT NOT NULL REFERENCES approval_requests(id), point_id TEXT NOT NULL REFERENCES review_items(id),
 PRIMARY KEY(approval_id,point_id)
);
CREATE TABLE approval_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, approval_id TEXT NOT NULL REFERENCES approval_requests(id),
 action TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES profiles(id), payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX approval_events_history ON approval_events(approval_id,sequence DESC);
CREATE TRIGGER approval_events_no_update BEFORE UPDATE ON approval_events BEGIN SELECT RAISE(ABORT,'Approval events are append-only'); END;
CREATE TRIGGER approval_events_no_delete BEFORE DELETE ON approval_events BEGIN SELECT RAISE(ABORT,'Approval events are append-only'); END;
CREATE TRIGGER approval_no_hard_delete BEFORE DELETE ON approval_requests BEGIN SELECT RAISE(ABORT,'Approval history is preserved'); END;
CREATE TRIGGER approval_identity_immutable BEFORE UPDATE OF id,number,project_id,document_id,revision_id,requester_id,previous_id,created_at ON approval_requests BEGIN SELECT RAISE(ABORT,'Approval revision and identity are immutable'); END;
CREATE TRIGGER approval_submitted_immutable BEFORE UPDATE OF title,description,responsible,approver_id,purpose,priority,due_date,message_id,technical_request_id ON approval_requests WHEN OLD.submitted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Submitted approval is frozen'); END;
CREATE TRIGGER approval_transition BEFORE UPDATE OF status ON approval_requests WHEN OLD.status<>NEW.status BEGIN SELECT RAISE(ABORT,'Invalid approval transition') WHERE NOT((OLD.status='draft' AND NEW.status IN('pending','cancelled')) OR (OLD.status='pending' AND NEW.status IN('approved','rejected','changes_requested','cancelled')) OR (OLD.status IN('approved','rejected','changes_requested') AND NEW.status='cancelled')); END;
CREATE TRIGGER approval_final_immutable BEFORE UPDATE OF decided_at,decided_by,decision_comment ON approval_requests WHEN OLD.status IN('approved','rejected','changes_requested','cancelled') BEGIN SELECT RAISE(ABORT,'Final approval decision is immutable'); END;
CREATE TRIGGER approval_delete_draft BEFORE UPDATE OF deleted_at ON approval_requests WHEN OLD.submitted_at IS NOT NULL OR OLD.status<>'draft' BEGIN SELECT RAISE(ABORT,'Only unsubmitted drafts can be deleted'); END;
CREATE TRIGGER approval_point_scope BEFORE INSERT ON approval_points BEGIN SELECT RAISE(ABORT,'Approval point must target exact revision') WHERE NOT EXISTS(SELECT 1 FROM review_items p JOIN approval_requests a ON a.id=NEW.approval_id WHERE p.id=NEW.point_id AND p.revision_id=a.revision_id AND p.is_point=1 AND p.point_deleted_at IS NULL); END;
CREATE TRIGGER approval_point_frozen BEFORE DELETE ON approval_points WHEN EXISTS(SELECT 1 FROM approval_requests WHERE id=OLD.approval_id AND submitted_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Submitted point references are preserved'); END;
CREATE TRIGGER approval_point_identity BEFORE UPDATE ON approval_points BEGIN SELECT RAISE(ABORT,'Point reference identity is immutable'); END;
CREATE TRIGGER approval_submission_immutable BEFORE UPDATE OF submitted_at ON approval_requests WHEN OLD.submitted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'Submission timestamp is immutable'); END;
CREATE UNIQUE INDEX approval_one_successor ON approval_requests(previous_id) WHERE previous_id IS NOT NULL AND deleted_at IS NULL;
CREATE TRIGGER approval_point_state BEFORE INSERT ON approval_points WHEN NOT EXISTS(SELECT 1 FROM approval_requests WHERE id=NEW.approval_id AND status IN('draft','changes_requested') AND deleted_at IS NULL) BEGIN SELECT RAISE(ABORT,'Approval point references are frozen'); END;
CREATE TRIGGER approval_submission_order_immutable BEFORE UPDATE OF submission_sequence ON approval_requests WHEN OLD.submission_sequence IS NOT NULL OR NOT EXISTS(SELECT 1 FROM approval_events WHERE sequence=NEW.submission_sequence AND approval_id=OLD.id AND action='approval.submit') BEGIN SELECT RAISE(ABORT,'Submission order is immutable and must match its event'); END;
