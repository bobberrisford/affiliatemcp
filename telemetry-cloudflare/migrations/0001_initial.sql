CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  package_version TEXT NOT NULL,
  surface TEXT NOT NULL,
  network TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, package_version, surface, network, operation, outcome)
);

CREATE TABLE IF NOT EXISTS install_activity (
  day TEXT NOT NULL,
  monthly_install_id TEXT NOT NULL,
  PRIMARY KEY (day, monthly_install_id)
);

CREATE TABLE IF NOT EXISTS ingest_receipts (
  day TEXT NOT NULL,
  monthly_install_id TEXT NOT NULL,
  PRIMARY KEY (day, monthly_install_id)
);

CREATE TABLE IF NOT EXISTS ecosystem_daily (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  dimension TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  PRIMARY KEY (day, metric, dimension)
);

CREATE TABLE IF NOT EXISTS package_versions (
  version TEXT PRIMARY KEY,
  published_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS install_activity_month ON install_activity(day, monthly_install_id);
