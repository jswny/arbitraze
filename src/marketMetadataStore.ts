import type { D1Database } from "@cloudflare/workers-types";
import type { MarketMetadata } from "./marketMetadata";

const UPSERT_MARKET_SQL = `
INSERT INTO markets (
	venue,
	id,
	symbol,
	identifiers,
	updated_at
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(venue, id) DO UPDATE SET
	symbol = excluded.symbol,
	identifiers = excluded.identifiers,
	updated_at = excluded.updated_at
`;

export async function upsertMarketMetadataBatch(
	database: D1Database,
	records: MarketMetadata[],
	logPrefix: string,
): Promise<void> {
	if (records.length === 0) {
		return;
	}

	const statements = records.map((record) => {
		const updatedAt = new Date().toISOString();
		const identifiers = serializeObject(record.identifiers);

		return database
			.prepare(UPSERT_MARKET_SQL)
			.bind(
				record.venue,
				record.id,
				nullIfEmpty(record.symbol ?? record.title ?? record.question),
				identifiers,
				updatedAt,
			);
	});

	try {
		await database.batch(statements);
	} catch (error) {
		console.error(`[${logPrefix}] failed to upsert markets in D1`, { error });
		throw error;
	}
}

function serializeObject<T>(value: T | undefined): string | null {
	if (!value) {
		return null;
	}
	return JSON.stringify(value);
}

function nullIfEmpty(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length ? trimmed : null;
}
