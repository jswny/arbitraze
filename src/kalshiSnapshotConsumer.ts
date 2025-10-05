import type { KalshiSnapshotMessage } from "./kalshiIngest";
import { processMarketSnapshotBatch } from "./marketSnapshotProcessor";
import type { MarketMetadata } from "./marketMetadata";

export async function processKalshiSnapshotBatch(
	batch: MessageBatch<KalshiSnapshotMessage>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	await processMarketSnapshotBatch(batch, env, {
		logPrefix: "KalshiQueue",
		extractMetadata: (message) => extractKalshiMarketMetadata(message.body),
		onSkip: (message) => {
			console.warn("[KalshiQueue] skipped message with missing ticker", {
				ingest_id: message.body.ingest_id,
				venue: message.body.venue,
			});
		},
	});
}

function extractKalshiMarketMetadata(message: KalshiSnapshotMessage): MarketMetadata | undefined {
	const raw = message.raw;
	const ticker = pickString(message.market.ticker) ?? pickString(raw?.ticker);
	if (!ticker) {
		return undefined;
	}

	const marketId = pickString(message.market.marketId) ?? pickString(getRaw(raw, "id"));
	const eventTicker = pickString(message.market.eventTicker) ?? pickString(getRaw(raw, "event_ticker"));
	const eventTitle = pickString(getRaw(raw, "event_title"));
	const question = pickString(getRaw(raw, "question") ?? getRaw(raw, "market_question"));
	const description = pickString(getRaw(raw, "description"));
	const primaryCategory = pickString(getRaw(raw, "event_category") ?? getRaw(raw, "category"));
	const subcategory = pickString(getRaw(raw, "event_subcategory") ?? getRaw(raw, "subcategory"));
	const openTime = pickIsoTimestamp(getRaw(raw, "open_time") ?? getRaw(raw, "open_date"));
	const closeTime = pickIsoTimestamp(getRaw(raw, "close_time") ?? getRaw(raw, "close_date"));

	const identifiers: Record<string, string> = {};
	if (marketId) {
		identifiers.marketId = marketId;
	}
	if (eventTicker) {
		identifiers.eventTicker = eventTicker;
	}

	const categories = uniqueArray([primaryCategory, subcategory]);

	const eventMetadata = {
		title: eventTitle ?? undefined,
		category: primaryCategory ?? undefined,
	};
	const hasEventMetadata = Object.values(eventMetadata).some((value) => !!value);

	const metadata: MarketMetadata = {
		id: marketId ?? ticker,
		venue: "kalshi",
		symbol: ticker,
		title: pickString(getRaw(raw, "title")) ?? question ?? eventTitle,
		question,
		description,
		categories: categories.length ? categories : undefined,
		startTime: openTime,
		endTime: closeTime,
		identifiers: Object.keys(identifiers).length ? identifiers : undefined,
		event: hasEventMetadata ? eventMetadata : undefined,
	};

	return metadata;
}

function getRaw(raw: Record<string, unknown> | undefined, key: string): unknown {
	if (!raw) {
		return undefined;
	}
	return raw[key];
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
