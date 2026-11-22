-- Personal API tokens, for agents and scripts (`Authorization: Bearer keel_...`).
-- Like sessions, only the token's SHA-256 is stored.
-- A loose document (made without an account) belongs to a guest user, and its key is a token
-- limited to that one document.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,              -- the last 4 characters, to tell tokens apart
  scope TEXT NOT NULL CHECK (scope IN ('write', 'read')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,              -- NULL: never
  document_id TEXT                 -- set: the token reaches only this document (a loose document's key)
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- Loose documents are deleted at this time (by the Worker's scheduled job). NULL: kept.
ALTER TABLE documents ADD COLUMN expires_at INTEGER;
CREATE INDEX documents_expiry ON documents(expires_at) WHERE expires_at IS NOT NULL;
