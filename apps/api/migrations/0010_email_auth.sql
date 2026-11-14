-- Additive identity provider: no profile, membership, ownership or R2 key is rewritten.
CREATE TABLE email_auth_user (id TEXT PRIMARY KEY, name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,emailVerified INTEGER NOT NULL DEFAULT 0,image TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
CREATE TABLE email_auth_session (id TEXT PRIMARY KEY,expiresAt TEXT NOT NULL,token TEXT NOT NULL UNIQUE,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,ipAddress TEXT,userAgent TEXT,userId TEXT NOT NULL REFERENCES email_auth_user(id) ON DELETE CASCADE);
CREATE INDEX email_session_user ON email_auth_session(userId);
CREATE TABLE email_auth_account (id TEXT PRIMARY KEY,accountId TEXT NOT NULL,providerId TEXT NOT NULL,userId TEXT NOT NULL REFERENCES email_auth_user(id) ON DELETE CASCADE,accessToken TEXT,refreshToken TEXT,idToken TEXT,accessTokenExpiresAt TEXT,refreshTokenExpiresAt TEXT,scope TEXT,password TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
CREATE INDEX email_account_user ON email_auth_account(userId);
CREATE TABLE email_auth_verification (id TEXT PRIMARY KEY,identifier TEXT NOT NULL,value TEXT NOT NULL,expiresAt TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
CREATE UNIQUE INDEX email_verification_identifier ON email_auth_verification(identifier);
CREATE TABLE email_auth_rate_limit (id TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,count INTEGER NOT NULL,lastRequest INTEGER NOT NULL);
CREATE TABLE email_auth_enrollments (email TEXT PRIMARY KEY,profile_id TEXT NOT NULL UNIQUE REFERENCES profiles(id),approved_by TEXT NOT NULL REFERENCES profiles(id),approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE email_auth_links (auth_user_id TEXT PRIMARY KEY REFERENCES email_auth_user(id),profile_id TEXT NOT NULL UNIQUE REFERENCES profiles(id),email TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TRIGGER email_link_immutable BEFORE UPDATE ON email_auth_links BEGIN SELECT RAISE(ABORT,'Reviewed identity links are immutable'); END;
CREATE TABLE email_auth_windows (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE email_auth_control (id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN(0,1)),admin_verified_at TEXT,recovery_verified_at TEXT);
INSERT INTO email_auth_control(id,enabled) VALUES(1,0);
