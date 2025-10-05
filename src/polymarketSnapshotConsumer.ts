import type { PolymarketSnapshotMessage } from "./polymarketIngest";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export interface PolymarketMarketMetadata {
	id: string;
	venue: "polymarket";
	slug: string;
	conditionId?: string;
	question?: string;
	description?: string;
	resolutionSource?: string;
	category?: string;
	groupTitle?: string;
	outcomes?: string[];
	outcomePrices?: string[];
	startTime?: string;
	endTime?: string;
	createdAt?: string;
	updatedAt?: string;
	volume?: string;
	volume24h?: string;
	liquidity?: string;
	lastTradePrice?: string;
	bestBid?: string;
	bestAsk?: string;
	restricted?: string;
	eventId?: string;
	eventSlug?: string;
	eventTitle?: string;
	eventDescription?: string;
	eventCategory?: string;
	eventStartTime?: string;
	eventEndTime?: string;
	seriesId?: string;
	seriesSlug?: string;
	seriesTitle?: string;
	seriesType?: string;
}

type PolymarketQueueMessage = Message<PolymarketSnapshotMessage>;

type EmbeddingResponse = {
	data?: Array<number[] | { embedding?: number[] }>;
	shape?: number[];
};

export async function processPolymarketSnapshotBatch(
	batch: MessageBatch<PolymarketSnapshotMessage>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	const pending: PolymarketQueueMessage[] = [];
	const metadataById = new Map<string, PolymarketMarketMetadata>();

	for (const rawMessage of batch.messages) {
		const message = rawMessage as PolymarketQueueMessage;
		const metadata = extractPolymarketMarketMetadata(message.body);
		if (!metadata) {
			console.warn(
				"[PolymarketQueue] skipped message with missing id or slug",
				{
					ingest_id: message.body.ingest_id,
					venue: message.body.venue,
				},
			);
			message.ack();
			continue;
		}

		metadataById.set(metadata.id, metadata);
		pending.push(message);
	}

	if (metadataById.size === 0) {
		return;
	}

	const records = Array.from(metadataById.values());
	try {
		await persistPolymarketMetadata(env, records);
	} catch (error) {
		console.error("[PolymarketQueue] metadata persistence failed", error);
		for (const message of pending) {
			message.retry();
		}
		return;
	}

	for (const message of pending) {
		message.ack();
	}
}

function extractPolymarketMarketMetadata(
	message: PolymarketSnapshotMessage,
): PolymarketMarketMetadata | undefined {
	const market = message.market;
	const raw = toRecord(message.raw);
	const id = pickString(market.id) ?? pickString(getRaw(raw, "id"));
	const slug = pickString(market.slug) ?? pickString(getRaw(raw, "slug"));
	if (!id || !slug) {
		return undefined;
	}

	const outcomes =
		normalizeStringArray(market.outcomes) ?? normalizeStringArray(parseStringArray(getRaw(raw, "outcomes")));
	const outcomePrices =
		normalizeNumberArray(market.outcomePrices) ?? normalizeNumberArray(parseNumberArray(getRaw(raw, "outcomePrices")));

	const metadata: PolymarketMarketMetadata = {
		id,
		venue: "polymarket",
		slug,
		conditionId: pickString(market.conditionId) ?? pickString(getRaw(raw, "conditionId")),
		question: pickString(market.question) ?? pickString(getRaw(raw, "question")),
		description: pickString(market.description) ?? pickString(getRaw(raw, "description")),
		resolutionSource: pickString(market.resolutionSource) ?? pickString(getRaw(raw, "resolutionSource")),
		category: pickString(market.category) ?? pickString(getRaw(raw, "category")),
		groupTitle: pickString(market.groupTitle) ?? pickString(getRaw(raw, "groupItemTitle")),
		outcomes,
		outcomePrices,
		startTime: pickIsoTimestamp(market.startTime ?? getRaw(raw, "startDate") ?? getRaw(raw, "start_time")),
		endTime: pickIsoTimestamp(market.endTime ?? getRaw(raw, "endDate") ?? getRaw(raw, "end_time")),
		createdAt: pickIsoTimestamp(market.createdAt ?? getRaw(raw, "createdAt")),
		updatedAt: pickIsoTimestamp(market.updatedAt ?? getRaw(raw, "updatedAt")),
		volume: formatNumber(pickNumber(market.volume ?? getRaw(raw, "volume"))),
		volume24h: formatNumber(pickNumber(market.volume24h ?? getRaw(raw, "volume24hr"))),
		liquidity: formatNumber(pickNumber(market.liquidity ?? getRaw(raw, "liquidity"))),
		lastTradePrice: formatNumber(pickNumber(market.lastTradePrice ?? getRaw(raw, "lastTradePrice"))),
		bestBid: formatNumber(pickNumber(market.bestBid ?? getRaw(raw, "bestBid"))),
		bestAsk: formatNumber(pickNumber(market.bestAsk ?? getRaw(raw, "bestAsk"))),
		restricted: pickBoolean(market.restricted ?? getRaw(raw, "restricted")),
		eventId: pickString(market.eventId) ?? pickString(getRaw(raw, "eventId")),
		eventSlug: pickString(market.eventSlug) ?? pickString(getRaw(raw, "eventSlug")),
		eventTitle: pickString(market.eventTitle) ?? pickString(getRaw(raw, "eventTitle")),
		eventDescription: pickString(market.eventDescription) ?? pickString(getRaw(raw, "eventDescription")),
		eventCategory: pickString(market.eventCategory) ?? pickString(getRaw(raw, "eventCategory")),
		eventStartTime: pickIsoTimestamp(market.eventStartTime ?? getRaw(raw, "eventStartTime")),
		eventEndTime: pickIsoTimestamp(market.eventEndTime ?? getRaw(raw, "eventEndTime")),
		seriesId: pickString(market.seriesId) ?? pickString(getRaw(raw, "seriesId")),
		seriesSlug: pickString(market.seriesSlug) ?? pickString(getRaw(raw, "seriesSlug")),
		seriesTitle: pickString(market.seriesTitle) ?? pickString(getRaw(raw, "seriesTitle")),
		seriesType: pickString(market.seriesType) ?? pickString(getRaw(raw, "seriesType")),
	};

	return metadata;
}

async function persistPolymarketMetadata(env: Env, records: PolymarketMarketMetadata[]): Promise<void> {
	if (records.length === 0) {
		return;
	}

	const vectorize = env.MATCH_VECTORIZE;
	if (!vectorize) {
		console.warn("[PolymarketQueue] missing MATCH_VECTORIZE binding; skip vector persist");
		return;
	}

	const ai = env.AI;
	if (!ai) {
		console.warn("[PolymarketQueue] missing AI binding; skip vector persist");
		return;
	}

	const documents = records
		.map((record) => ({ record, text: buildEmbeddingDocument(record) }))
		.filter((item): item is { record: PolymarketMarketMetadata; text: string } => !!item.text);

	if (documents.length === 0) {
		console.warn("[PolymarketQueue] no documents with text content available for embedding");
		return;
	}

	const response = await ai.run(EMBEDDING_MODEL, {
		text: documents.map((item) => item.text),
	});

	const vectors: VectorizeVector[] = [];
	for (const [index, item] of documents.entries()) {
		const values = extractEmbeddingVector(response, index);
		if (!values) {
			console.warn("[PolymarketQueue] embedding response missing vector", { id: item.record.id });
			continue;
		}

		vectors.push({
			id: item.record.id,
			values,
			metadata: buildVectorMetadata(item.record),
		});
	}

	if (vectors.length === 0) {
		console.warn("[PolymarketQueue] no embeddings extracted; skip upsert");
		return;
	}

	await vectorize.upsert(vectors);
	console.log(`[PolymarketQueue] upserted ${vectors.length} vector(s) into Vectorize`);
}

function buildEmbeddingDocument(record: PolymarketMarketMetadata): string | undefined {
	const sections: string[] = [];
	sections.push(`Venue: ${record.venue}`);
	sections.push(`Market ID: ${record.id}`);
	sections.push(`Slug: ${record.slug}`);

	appendIfPresent(sections, "Condition ID", record.conditionId);
	appendIfPresent(sections, "Question", record.question);
	appendIfPresent(sections, "Description", record.description);
	appendIfPresent(sections, "Resolution Source", record.resolutionSource);
	appendIfPresent(sections, "Category", record.category);
	appendIfPresent(sections, "Group", record.groupTitle);
	if (record.outcomes?.length) {
		sections.push(`Outcomes: ${record.outcomes.join(", ")}`);
	}
	if (record.outcomePrices?.length) {
		sections.push(`Outcome Prices: ${record.outcomePrices.join(", ")}`);
	}
	appendIfPresent(sections, "Start", record.startTime);
	appendIfPresent(sections, "End", record.endTime);
	appendIfPresent(sections, "Created", record.createdAt);
	appendIfPresent(sections, "Updated", record.updatedAt);
	appendIfPresent(sections, "Volume", record.volume);
	appendIfPresent(sections, "Volume 24h", record.volume24h);
	appendIfPresent(sections, "Liquidity", record.liquidity);
	appendIfPresent(sections, "Last Trade Price", record.lastTradePrice);
	appendIfPresent(sections, "Best Bid", record.bestBid);
	appendIfPresent(sections, "Best Ask", record.bestAsk);
	appendIfPresent(sections, "Restricted", record.restricted);
	appendIfPresent(sections, "Event Title", record.eventTitle);
	appendIfPresent(sections, "Event Description", record.eventDescription);
	appendIfPresent(sections, "Event Category", record.eventCategory);
	appendIfPresent(sections, "Event Slug", record.eventSlug);
	appendIfPresent(sections, "Event Start", record.eventStartTime);
	appendIfPresent(sections, "Event End", record.eventEndTime);
	appendIfPresent(sections, "Series Title", record.seriesTitle);
	appendIfPresent(sections, "Series Slug", record.seriesSlug);
	appendIfPresent(sections, "Series Type", record.seriesType);

	const content = sections
		.map((value) => value?.trim())
		.filter((value): value is string => !!value && value.length > 0)
		.join("\n\n");

	return content.length ? content : undefined;
}

function buildVectorMetadata(record: PolymarketMarketMetadata): Record<string, VectorizeVectorMetadata> {
	const metadata: Record<string, VectorizeVectorMetadata> = {
		venue: record.venue,
		slug: record.slug,
	};

	assignIfPresent(metadata, "conditionId", record.conditionId);
	assignIfPresent(metadata, "category", record.category);
	assignIfPresent(metadata, "groupTitle", record.groupTitle);
	assignIfPresent(metadata, "startTime", record.startTime);
	assignIfPresent(metadata, "endTime", record.endTime);
	assignIfPresent(metadata, "eventId", record.eventId);
	assignIfPresent(metadata, "eventSlug", record.eventSlug);
	assignIfPresent(metadata, "eventTitle", record.eventTitle);
	assignIfPresent(metadata, "eventCategory", record.eventCategory);
	assignIfPresent(metadata, "eventStartTime", record.eventStartTime);
	assignIfPresent(metadata, "eventEndTime", record.eventEndTime);
	assignIfPresent(metadata, "seriesId", record.seriesId);
	assignIfPresent(metadata, "seriesSlug", record.seriesSlug);
	assignIfPresent(metadata, "seriesTitle", record.seriesTitle);
	assignIfPresent(metadata, "seriesType", record.seriesType);
	assignIfPresent(metadata, "restricted", record.restricted);
	if (record.outcomes?.length) {
		metadata.outcomes = record.outcomes;
	}

	return metadata;
}

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

	const nested = (entry as { embedding?: number[] }).embedding;
	if (Array.isArray(nested)) {
		return Float32Array.from(nested);
	}

	return undefined;
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

function pickNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function pickBoolean(value: unknown): string | undefined {
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "false") {
			return normalized;
		}
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

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const items = value.map(pickString).filter((item): item is string => typeof item === "string");
	return items.length ? items : undefined;
}

function normalizeNumberArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const items = value
		.map(pickNumber)
		.filter((item): item is number => typeof item === "number")
		.map(formatNumber)
		.filter((item): item is string => typeof item === "string");
	return items.length ? items : undefined;
}

function parseStringArray(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch (_error) {
			return undefined;
		}
	}
	return undefined;
}

function parseNumberArray(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch (_error) {
			return undefined;
		}
	}
	return undefined;
}

function formatNumber(value: number | undefined): string | undefined {
	if (typeof value !== "number") {
		return undefined;
	}
	if (!Number.isFinite(value)) {
		return undefined;
	}
	return value.toString();
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
