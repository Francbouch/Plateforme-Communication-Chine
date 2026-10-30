ALTER TABLE review_items ADD COLUMN is_point INTEGER NOT NULL DEFAULT 0 CHECK(is_point IN(0,1));
ALTER TABLE review_items ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE review_items ADD COLUMN publication TEXT NOT NULL DEFAULT 'draft' CHECK(publication IN('draft','published'));
ALTER TABLE review_items ADD COLUMN point_deleted_at TEXT;
ALTER TABLE review_items ADD COLUMN cancelled_at TEXT;
ALTER TABLE review_items ADD COLUMN legacy_review INTEGER NOT NULL DEFAULT 1;
UPDATE review_items SET is_point=1,title=substr(CASE WHEN trim(summary)<>'' THEN summary WHEN type='discussion' THEN content ELSE 'Ancien échange à examiner' END,1,200)
WHERE type='discussion' OR trim(summary)<>'' OR trim(responsible)<>'' OR status<>'open'
OR EXISTS(SELECT 1 FROM review_messages m WHERE m.item_id=review_items.id)
OR EXISTS(SELECT 1 FROM review_events e WHERE e.item_id=review_items.id AND (e.action LIKE 'reply.%' OR trim(COALESCE(json_extract(e.payload,'$.summary'),''))<>'' OR trim(COALESCE(json_extract(e.payload,'$.before.summary'),''))<>'' OR trim(COALESCE(json_extract(e.payload,'$.after.summary'),''))<>''));
CREATE TABLE graphical_annotations (
 id TEXT PRIMARY KEY,
 document_id TEXT NOT NULL,
 revision_id TEXT NOT NULL,
 page INTEGER NOT NULL CHECK(page BETWEEN 1 AND 10000),
 type TEXT NOT NULL CHECK(type IN('marker','rectangle','arrow','freehand','highlight','text')),
 color TEXT NOT NULL CHECK(color IN('red','orange','yellow','green','blue')),
 geometry TEXT NOT NULL CHECK(json_valid(geometry)),
 content TEXT NOT NULL DEFAULT '' CHECK(length(content)<=2000),
 created_by TEXT NOT NULL REFERENCES profiles(id),
 version INTEGER NOT NULL DEFAULT 1,
 point_id TEXT REFERENCES review_items(id),
 annotation_deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(document_id,revision_id) REFERENCES document_revisions(document_id,id)
);
INSERT INTO graphical_annotations(id,document_id,revision_id,page,type,color,geometry,content,created_by,version,point_id,annotation_deleted_at,created_at,updated_at)
SELECT id,document_id,revision_id,page,type,color,geometry,content,created_by,version,CASE WHEN is_point=1 AND annotation_deleted_at IS NULL THEN id END,annotation_deleted_at,created_at,updated_at FROM review_items WHERE type<>'discussion';
CREATE INDEX graphical_page ON graphical_annotations(revision_id,page,created_at);
CREATE INDEX graphical_point ON graphical_annotations(point_id,annotation_deleted_at);
CREATE INDEX technical_points_active ON review_items(document_id,is_point,point_deleted_at,publication,number);
CREATE TRIGGER graphical_link_insert BEFORE INSERT ON graphical_annotations WHEN NEW.point_id IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM review_items p WHERE p.id=NEW.point_id AND p.is_point=1 AND p.point_deleted_at IS NULL AND p.document_id=NEW.document_id AND p.revision_id=NEW.revision_id) THEN RAISE(ABORT,'point revision mismatch') END; END;
CREATE TRIGGER graphical_link_update BEFORE UPDATE OF point_id ON graphical_annotations WHEN NEW.point_id IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM review_items p WHERE p.id=NEW.point_id AND p.is_point=1 AND p.point_deleted_at IS NULL AND p.document_id=NEW.document_id AND p.revision_id=NEW.revision_id) THEN RAISE(ABORT,'point revision mismatch') END; END;
CREATE TRIGGER graphical_identity BEFORE UPDATE OF id,document_id,revision_id,page,type,created_by ON graphical_annotations BEGIN SELECT RAISE(ABORT,'annotation identity is immutable'); END;
CREATE TRIGGER technical_point_detach AFTER UPDATE OF point_deleted_at ON review_items WHEN NEW.point_deleted_at IS NOT NULL AND OLD.point_deleted_at IS NULL BEGIN UPDATE graphical_annotations SET point_id=NULL,version=version+1 WHERE point_id=NEW.id; END;
