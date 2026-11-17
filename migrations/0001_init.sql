-- Keel: accounts, sessions, documents, sharing, versions.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE INDEX documents_owner ON documents(owner_id);

-- role: 'edit' or 'view'
CREATE TABLE shares (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('edit', 'view')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX shares_user ON shares(user_id);

-- A version is a named snapshot kept in R2 at versions/<document_id>/<id>.json.
CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX versions_doc ON versions(document_id, created_at);
