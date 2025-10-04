import type { KalshiSnapshotMessage } from "./kalshiIngest";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

type KalshiSnapshotQueueMessage = Message<KalshiSnapshotMessage>;

export interface KalshiMarketMetadata {
	id: string;
	venue: "kalshi";
	ticker: string;
	marketId?: string;
	eventTicker?: string;
	title?: string;
	question?: string;
	description?: string;
	eventTitle?: string;
	seriesTicker?: string;
	category?: string;
	subcategory?: string;
	tags?: string[];
	rules?: string;
	openTime?: string;
	closeTime?: string;
	settlementType?: string;
}

export async function processKalshiSnapshotBatch(
	batch: MessageBatch<KalshiSnapshotMessage>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	const pendingAcks: KalshiSnapshotQueueMessage[] = [];
	const metadataById = new Map<string, KalshiMarketMetadata>();

	for (const message of batch.messages) {
		const metadata = extractKalshiMarketMetadata(message.body);
		if (!metadata) {
			console.warn(
				"[KalshiQueue] skipped message with missing ticker",
				{
					ingest_id: message.body.ingest_id,
					venue: message.body.venue,
				},
			);
			message.ack();
			continue;
		}

		metadataById.set(metadata.id, metadata);
		pendingAcks.push(message);
	}

	if (metadataById.size === 0) {
		return;
	}

	const records = Array.from(metadataById.values());
	try {
		await persistKalshiMetadata(env, records);
	} catch (error) {
		console.error("[KalshiQueue] metadata persistence failed", error);
		for (const message of pendingAcks) {
			message.retry();
		}
		return;
	}

	for (const message of pendingAcks) {
		message.ack();
	}
}

function extractKalshiMarketMetadata(message: KalshiSnapshotMessage): KalshiMarketMetadata | undefined {
	const raw = message.raw;
	const ticker = pickString(message.market.ticker) ?? pickString(raw?.ticker);
	if (!ticker) {
		return undefined;
	}

	const marketId = pickString(message.market.marketId) ?? pickString(getRaw(raw, "id"));
	const eventTicker = pickString(message.market.eventTicker) ?? pickString(getRaw(raw, "event_ticker"));

	const metadata: KalshiMarketMetadata = {
		id: marketId ?? ticker,
		venue: "kalshi",
		ticker,
		marketId,
		eventTicker,
		seriesTicker: pickString(getRaw(raw, "series_ticker")),
		eventTitle: pickString(getRaw(raw, "event_title")),
		title: pickString(getRaw(raw, "title")),
		question: pickString(getRaw(raw, "question") ?? getRaw(raw, "market_question")),
		description: pickString(getRaw(raw, "description")),
		category: pickString(getRaw(raw, "event_category") ?? getRaw(raw, "category")),
		subcategory: pickString(getRaw(raw, "event_subcategory") ?? getRaw(raw, "subcategory")),
		tags: pickStringArray(getRaw(raw, "tags")),
		rules: pickString(getRaw(raw, "rules")),
		openTime: pickIsoTimestamp(getRaw(raw, "open_time") ?? getRaw(raw, "open_date")),
		closeTime: pickIsoTimestamp(getRaw(raw, "close_time") ?? getRaw(raw, "close_date")),
		settlementType: pickString(getRaw(raw, "settlement_type") ?? getRaw(raw, "settlement")),
	};

	return metadata;
}

async function persistKalshiMetadata(env: Env, records: KalshiMarketMetadata[]): Promise<void> {
	if (records.length === 0) {
		return;
	}

	const vectorize = env.MATCH_VECTORIZE;
	if (!vectorize) {
		console.warn("[KalshiQueue] missing MATCH_VECTORIZE binding; skip vector persist");
		return;
	}

	const ai = env.AI;
	if (!ai) {
		console.warn("[KalshiQueue] missing AI binding; skip vector persist");
		return;
	}

	const documents = records
		.map((record) => ({ record, text: buildEmbeddingDocument(record) }))
		.filter((item): item is { record: KalshiMarketMetadata; text: string } => !!item.text);

	if (documents.length === 0) {
		console.warn("[KalshiQueue] no documents with text content available for embedding");
		return;
	}

	const response = await ai.run(EMBEDDING_MODEL, {
		text: documents.map((item) => item.text),
	});

	const vectors: VectorizeVector[] = [];
	for (const [index, item] of documents.entries()) {
		const values = extractEmbeddingVector(response, index);
		if (!values) {
			console.warn("[KalshiQueue] embedding response missing vector", { id: item.record.id });
			continue;
		}

		vectors.push({
			id: item.record.id,
			values,
			metadata: buildVectorMetadata(item.record),
		});
	}

	if (vectors.length === 0) {
		console.warn("[KalshiQueue] no embeddings extracted; skip upsert");
		return;
	}

	await vectorize.upsert(vectors);
	console.log(`[KalshiQueue] upserted ${vectors.length} vector(s) into Vectorize`);
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

function pickStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const items = value
		.map(pickString)
		.filter((item): item is string => typeof item === "string");

	return items.length ? items : undefined;
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

function buildEmbeddingDocument(record: KalshiMarketMetadata): string | undefined {
	const sections: string[] = [];
	sections.push(`Venue: ${record.venue}`);
	sections.push(`Ticker: ${record.ticker}`);

	if (record.marketId) {
		sections.push(`Market ID: ${record.marketId}`);
	}
	if (record.eventTicker) {
		sections.push(`Event Ticker: ${record.eventTicker}`);
	}
	if (record.seriesTicker) {
		sections.push(`Series Ticker: ${record.seriesTicker}`);
	}

	appendIfPresent(sections, "Title", record.title);
	appendIfPresent(sections, "Question", record.question);
	appendIfPresent(sections, "Description", record.description);
	appendIfPresent(sections, "Event Title", record.eventTitle);
	appendIfPresent(sections, "Category", record.category);
	appendIfPresent(sections, "Subcategory", record.subcategory);
	if (record.tags?.length) {
		sections.push(`Tags: ${record.tags.join(", ")}`);
	}
	appendIfPresent(sections, "Rules", record.rules);
	appendIfPresent(sections, "Opens", record.openTime);
	appendIfPresent(sections, "Closes", record.closeTime);
	appendIfPresent(sections, "Settlement", record.settlementType);

	const content = sections
		.map((value) => value?.trim())
		.filter((value): value is string => !!value && value.length > 0)
		.join("\n\n");

	return content.length ? content : undefined;
}

function appendIfPresent(target: string[], label: string, value: string | undefined): void {
	if (!value) {
		return;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return;
	}
	target.push(`${label}: ${trimmed}`);
}

type EmbeddingResponse = {
	data?: Array<number[] | { embedding?: number[] }>;
	shape?: number[];
};

function extractEmbeddingVector(response: unknown, index: number): Float32Array | undefined {
	const data = (response as EmbeddingResponse | undefined)?.data;
	if (!Array.isArray(data)) {
		return undefined;
	}

	const entry = data[index];
	if (!entry) {
		return undefined;
	}

	if (Array.isArray(entry)) {
		return Float32Array.from(entry);
	}

	const nested = entry.embedding;
	if (Array.isArray(nested)) {
		return Float32Array.from(nested);
	}

	return undefined;
}

function buildVectorMetadata(record: KalshiMarketMetadata): Record<string, VectorizeVectorMetadata> {
	const metadata: Record<string, VectorizeVectorMetadata> = {
		venue: record.venue,
		ticker: record.ticker,
	};

	assignIfPresent(metadata, "marketId", record.marketId);
	assignIfPresent(metadata, "eventTicker", record.eventTicker);
	assignIfPresent(metadata, "seriesTicker", record.seriesTicker);
	assignIfPresent(metadata, "category", record.category);
	assignIfPresent(metadata, "subcategory", record.subcategory);
	if (record.tags?.length) {
		metadata.tags = record.tags;
	}
	assignIfPresent(metadata, "openTime", record.openTime);
	assignIfPresent(metadata, "closeTime", record.closeTime);
	assignIfPresent(metadata, "settlementType", record.settlementType);

	return metadata;
}

function assignIfPresent(
	target: Record<string, VectorizeVectorMetadata>,
	key: string,
	value: string | undefined,
): void {
	if (!value) {
		return;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return;
	}
	target[key] = trimmed;
}
