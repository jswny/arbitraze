-- Store the minimum viable fields needed to reference markets later.
CREATE TABLE IF NOT EXISTS markets (
	venue TEXT NOT NULL,
	id TEXT NOT NULL,
	symbol TEXT,
	identifiers TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (venue, id)
);
