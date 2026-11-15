-- Hisaab cloud schema. Applied on start-up; every statement is idempotent.

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  pass_hash   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS shops (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES accounts(id),
  seq         BIGINT NOT NULL DEFAULT 0,   -- last change sequence number in this shop
  next_index  INT NOT NULL DEFAULT 0,      -- next device index (id block, bill series letter)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  shop_id       TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  idx           INT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'counter',
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  UNIQUE (shop_id, idx)
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code        TEXT PRIMARY KEY,
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  created_by  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

-- Latest state of every synced row. The feed is ordered by seq, so it compacts itself:
-- a row edited ten times appears once, at its newest position.
CREATE TABLE IF NOT EXISTS rows (
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  tbl         TEXT NOT NULL,
  id          BIGINT NOT NULL,
  data        JSONB,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  seq         BIGINT NOT NULL,
  device_id   TEXT NOT NULL,
  txn         BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, tbl, id)
);
CREATE INDEX IF NOT EXISTS rows_feed ON rows (shop_id, seq);
CREATE INDEX IF NOT EXISTS rows_voucher ON rows (shop_id, (data->>'voucher_type'), (data->>'voucher_id')) WHERE tbl = 'ledger_entries';

-- Encrypted database snapshots. The server never sees the passphrase or the plain data.
CREATE TABLE IF NOT EXISTS backups (
  id          TEXT PRIMARY KEY,
  shop_id     TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  device_id   TEXT,
  note        TEXT,
  size        BIGINT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backups_shop ON backups (shop_id, created_at DESC);
