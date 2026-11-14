-- Display-only, content-addressed extraction; originals, revisions, R2 and old permissions unchanged.
CREATE TABLE pdf_text_segments (
 id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES document_revisions(id),
 page INTEGER NOT NULL CHECK(page>0), original TEXT NOT NULL CHECK(length(original) BETWEEN 1 AND 600),
 geometry TEXT NOT NULL CHECK(json_valid(geometry)), extraction_version TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES profiles(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX pdf_text_revision ON pdf_text_segments(revision_id,page,id);
CREATE TRIGGER pdf_segment_immutable BEFORE UPDATE ON pdf_text_segments BEGIN SELECT RAISE(ABORT,'PDF extraction is immutable'); END;
CREATE TABLE pdf_translations (
 id TEXT PRIMARY KEY, segment_id TEXT NOT NULL REFERENCES pdf_text_segments(id),
 audience TEXT NOT NULL CHECK(audience IN('internal','shared')), source_language TEXT NOT NULL,
 target_language TEXT NOT NULL CHECK(target_language IN('fr','en','zh-CN')),
 reused_from TEXT REFERENCES pdf_translations(id),
 provider TEXT NOT NULL, glossary_hash TEXT NOT NULL, cache_key TEXT NOT NULL UNIQUE,
 machine TEXT NOT NULL, warnings TEXT NOT NULL CHECK(json_valid(warnings)),
 created_by TEXT NOT NULL REFERENCES profiles(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX pdf_translation_lookup ON pdf_translations(segment_id,audience,source_language,target_language,created_at);
CREATE TABLE pdf_translation_corrections (
 id TEXT PRIMARY KEY, translation_id TEXT NOT NULL REFERENCES pdf_translations(id),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2400), version INTEGER NOT NULL,
 author_id TEXT NOT NULL REFERENCES profiles(id), verified INTEGER NOT NULL CHECK(verified IN(0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(translation_id,version)
);
CREATE TABLE pdf_translation_reviews (
 id TEXT PRIMARY KEY, correction_id TEXT NOT NULL UNIQUE REFERENCES pdf_translation_corrections(id),
 reviewer_id TEXT NOT NULL REFERENCES profiles(id), approved INTEGER NOT NULL CHECK(approved IN(0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER pdf_correction_immutable BEFORE UPDATE ON pdf_translation_corrections BEGIN SELECT RAISE(ABORT,'PDF correction history is immutable'); END;
CREATE TRIGGER pdf_correction_retained BEFORE DELETE ON pdf_translation_corrections BEGIN SELECT RAISE(ABORT,'PDF correction history is retained'); END;
CREATE TRIGGER pdf_review_immutable BEFORE UPDATE ON pdf_translation_reviews BEGIN SELECT RAISE(ABORT,'PDF review history is immutable'); END;
CREATE TRIGGER pdf_review_retained BEFORE DELETE ON pdf_translation_reviews BEGIN SELECT RAISE(ABORT,'PDF review history is retained'); END;
CREATE TABLE pdf_translation_positions (
 segment_id TEXT NOT NULL REFERENCES pdf_text_segments(id),user_id TEXT NOT NULL REFERENCES profiles(id),
 dx REAL NOT NULL DEFAULT 0 CHECK(dx BETWEEN -1 AND 1),dy REAL NOT NULL DEFAULT 0 CHECK(dy BETWEEN -1 AND 1),
 PRIMARY KEY(segment_id,user_id)
);
