-- OAuth 2.1 for MCP clients (claude.ai and ChatGPT connectors, Claude Code's /mcp sign-in).
-- Clients register themselves (RFC 7591); access tokens are ordinary api_tokens rows.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,     -- JSON list
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,         -- PKCE S256
  expires_at INTEGER NOT NULL
);
CREATE TABLE oauth_refresh (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  api_token_id TEXT NOT NULL,      -- the access token it renews (replaced on each refresh)
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_refresh_user ON oauth_refresh(user_id);
