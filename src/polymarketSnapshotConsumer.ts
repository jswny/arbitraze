import type { PolymarketSnapshotMessage } from "./polymarketIngest";
import { processMarketSnapshotBatch } from "./marketSnapshotProcessor";
import type { MarketMetadata } from "./marketMetadata";

export async function processPolymarketSnapshotBatch(
	batch: MessageBatch<PolymarketSnapshotMessage>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	await processMarketSnapshotBatch(batch, env, {
		logPrefix: "PolymarketQueue",
		extractMetadata: (message) => extractPolymarketMarketMetadata(message.body),
		onSkip: (message) => {
			console.warn("[PolymarketQueue] skipped message with missing id or slug", {
				ingest_id: message.body.ingest_id,
				venue: message.body.venue,
			});
		},
	});
}

function extractPolymarketMarketMetadata(
	message: PolymarketSnapshotMessage,
): MarketMetadata | undefined {
	const market = message.market;
	const raw = toRecord(message.raw);
	const id = pickString(market.id) ?? pickString(getRaw(raw, "id"));
	const slug = pickString(market.slug) ?? pickString(getRaw(raw, "slug"));
	if (!id || !slug) {
		return undefined;
	}

	const conditionId = pickString(market.conditionId) ?? pickString(getRaw(raw, "conditionId"));
	const question = pickString(market.question) ?? pickString(getRaw(raw, "question"));
	const description = pickString(market.description) ?? pickString(getRaw(raw, "description"));
	const category = pickString(market.category) ?? pickString(getRaw(raw, "category"));
	const startTime = pickIsoTimestamp(market.startTime ?? getRaw(raw, "startDate") ?? getRaw(raw, "start_time"));
	const endTime = pickIsoTimestamp(market.endTime ?? getRaw(raw, "endDate") ?? getRaw(raw, "end_time"));
	const eventId = pickString(market.eventId) ?? pickString(getRaw(raw, "eventId"));
	const eventTitle = pickString(market.eventTitle) ?? pickString(getRaw(raw, "eventTitle"));
	const eventCategory = pickString(market.eventCategory) ?? pickString(getRaw(raw, "eventCategory"));
	const seriesId = pickString(market.seriesId) ?? pickString(getRaw(raw, "seriesId"));

	const identifiers: Record<string, string> = {};
	if (conditionId) {
		identifiers.conditionId = conditionId;
	}
	if (eventId) {
		identifiers.eventId = eventId;
	}
	if (seriesId) {
		identifiers.seriesId = seriesId;
	}

	const categories = uniqueArray([category, eventCategory]);

	const eventMetadata = {
		title: eventTitle ?? undefined,
		category: eventCategory ?? undefined,
	};
	const hasEventMetadata = Object.values(eventMetadata).some((value) => !!value);

	const metadata: MarketMetadata = {
		id,
		venue: "polymarket",
		symbol: slug,
		title: question ?? eventTitle ?? slug,
		question,
		description,
		categories: categories.length ? categories : undefined,
		startTime,
		endTime,
		identifiers: Object.keys(identifiers).length ? identifiers : undefined,
		event: hasEventMetadata ? eventMetadata : undefined,
	};

	if (!metadata.title && eventTitle) {
		metadata.title = eventTitle;
	}

	return metadata;
}

function pickString(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
}



function pickIsoTimestamp(value: unknown): string | undefined {
	const raw = pickString(value);
	if (!raw) {
		return undefined;
	}
	const date = new Date(raw);
	if (Number.isNaN(date.valueOf())) {
		return undefined;
	}
	return date.toISOString();
}

function uniqueArray(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = pickString(value);
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function getRaw(raw: Record<string, unknown> | undefined, key: string): unknown {
	return raw ? raw[key] : undefined;
}
