-- Additive, private text translations. No changes to original content or R2.
CREATE TABLE translation_glossary (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
 project_id TEXT REFERENCES projects(id), -- reserved for future project-specific vocabulary
 fr TEXT NOT NULL CHECK(length(fr) BETWEEN 1 AND 160), en TEXT NOT NULL CHECK(length(en) BETWEEN 1 AND 160),
 zh_cn TEXT NOT NULL CHECK(length(zh_cn) BETWEEN 1 AND 160),
 definition TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1, deleted_at TEXT,
 updated_by TEXT NOT NULL REFERENCES profiles(id), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX translation_glossary_org ON translation_glossary(organization_id,deleted_at,domain,id);
CREATE TABLE translations (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_field TEXT NOT NULL,
 source_hash TEXT NOT NULL, original TEXT NOT NULL CHECK(length(original) BETWEEN 1 AND 8000),
 source_language TEXT NOT NULL, target_language TEXT NOT NULL CHECK(target_language IN('fr','en','zh-CN')),
 detected_language TEXT, provider TEXT NOT NULL, instructions_version TEXT NOT NULL, glossary_hash TEXT NOT NULL,
 cache_key TEXT NOT NULL, machine TEXT NOT NULL, warnings TEXT NOT NULL CHECK(json_valid(warnings)),
 created_by TEXT NOT NULL REFERENCES profiles(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX translations_cache ON translations(organization_id,cache_key,sequence DESC);
CREATE TABLE translation_corrections (
 id TEXT PRIMARY KEY, translation_id TEXT NOT NULL REFERENCES translations(id),
 version INTEGER NOT NULL CHECK(version>0), body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 16000),
 warnings TEXT NOT NULL CHECK(json_valid(warnings)), actor_id TEXT NOT NULL REFERENCES profiles(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(translation_id,version)
);
CREATE TABLE translation_locks (cache_key TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE translation_attempts (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), actor_id TEXT NOT NULL REFERENCES profiles(id),
 characters INTEGER NOT NULL, created INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX translation_daily ON translation_attempts(organization_id,created);
CREATE INDEX translation_frequency ON translation_attempts(actor_id,created);
CREATE TRIGGER translation_no_update BEFORE UPDATE ON translations BEGIN SELECT RAISE(ABORT,'Translation generations are immutable'); END;
CREATE TRIGGER translation_no_delete BEFORE DELETE ON translations BEGIN SELECT RAISE(ABORT,'Translation generations are preserved'); END;
CREATE TRIGGER translation_correction_no_update BEFORE UPDATE ON translation_corrections BEGIN SELECT RAISE(ABORT,'Translation corrections are append-only'); END;
CREATE TRIGGER translation_correction_no_delete BEFORE DELETE ON translation_corrections BEGIN SELECT RAISE(ABORT,'Translation corrections are append-only'); END;
