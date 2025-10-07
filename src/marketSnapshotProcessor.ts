import {
	buildEmbeddingDocument,
	buildVectorMetadata,
	type MarketMetadata,
} from "./marketMetadata";

const VECTOR_MATCH_THRESHOLD = 0.85;
const VECTOR_MATCH_TOP_K = 3;

interface ProcessMarketSnapshotOptions<T> {
	logPrefix: string;
	extractMetadata: (message: Message<T>) => MarketMetadata | undefined;
	onSkip?: (message: Message<T>) => void;
}

type EmbeddingResponse = {
	data?: Array<number[] | { embedding?: number[] }>;
	shape?: number[];
};

export async function processMarketSnapshotBatch<T>(
	batch: MessageBatch<T>,
	env: Env,
	options: ProcessMarketSnapshotOptions<T>,
): Promise<void> {
	const pending: Message<T>[] = [];
	const metadataById = new Map<string, MarketMetadata>();

	for (const message of batch.messages) {
		const metadata = options.extractMetadata(message);
		if (!metadata) {
			options.onSkip?.(message);
			message.ack();
			continue;
		}

		metadataById.set(metadata.id, metadata);
		pending.push(message);
	}

	if (metadataById.size === 0) {
		return;
	}

	try {
		await persistMarketMetadata(env, Array.from(metadataById.values()), options.logPrefix);
	} catch (error) {
		console.error(`[${options.logPrefix}] metadata persistence failed`, error);
		for (const message of pending) {
			message.retry();
		}
		return;
	}

	for (const message of pending) {
		message.ack();
	}
}

async function persistMarketMetadata(
	env: Env,
	records: MarketMetadata[],
	logPrefix: string,
): Promise<void> {
	if (records.length === 0) {
		return;
	}

	const vectorize = env.MARKET_METADATA_VECTORS;
	if (!vectorize) {
		console.warn(`[${logPrefix}] missing MARKET_METADATA_VECTORS binding; skip vector persist`);
		return;
	}

	const ai = env.AI;
	if (!ai) {
		console.warn(`[${logPrefix}] missing AI binding; skip vector persist`);
		return;
	}

	const documents = records
		.map((record) => ({ record, text: buildEmbeddingDocument(record) }))
		.filter((item): item is { record: MarketMetadata; text: string } => !!item.text);

	if (documents.length === 0) {
		console.warn(`[${logPrefix}] no documents with text content available for embedding`);
		return;
	}

	const resolvedModel = resolveEmbeddingModel(env);
	const response = await ai.run(resolvedModel, {
		text: documents.map((item) => item.text),
	});

	const vectors: VectorizeVector[] = [];
	const recordById = new Map<string, MarketMetadata>();
	for (const [index, item] of documents.entries()) {
		const values = extractEmbeddingVector(response, index);
		if (!values) {
			console.warn(`[${logPrefix}] embedding response missing vector`, { id: item.record.id });
			continue;
		}

		vectors.push({
			id: item.record.id,
			values,
			metadata: buildVectorMetadata(item.record),
		});
		recordById.set(item.record.id, item.record);
	}

	if (vectors.length === 0) {
		console.warn(`[${logPrefix}] no embeddings extracted; skip upsert`);
		return;
	}

	await vectorize.upsert(vectors);
	console.log(
		`[${logPrefix}] upserted ${vectors.length} vector(s) using model ${resolvedModel} into Vectorize`,
	);

	await logPotentialMatches(vectorize, vectors, recordById, logPrefix);
}

type AiModelName = Parameters<Ai["run"]>[0];

function resolveEmbeddingModel(env: Env): AiModelName {
	return env.MARKET_EMBEDDING_MODEL as AiModelName;
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

	const nested = entry.embedding;
	if (Array.isArray(nested)) {
		return Float32Array.from(nested);
	}

	return undefined;
}

async function logPotentialMatches(
	vectorize: VectorizeIndex,
	vectors: VectorizeVector[],
	recordById: Map<string, MarketMetadata>,
	logPrefix: string,
): Promise<void> {
	for (const vector of vectors) {
		const source = recordById.get(vector.id);
		if (!source) {
			continue;
		}

		try {
			const matches = await vectorize.query(vector.values, {
				topK: VECTOR_MATCH_TOP_K,
				returnMetadata: "indexed",
				filter: {
					venue: { $ne: source.venue },
				},
			});
			const best = matches.matches?.[0];
			if (!best || typeof best.score !== "number" || best.score < VECTOR_MATCH_THRESHOLD) {
				continue;
			}

			if (!best.id || best.id === vector.id) {
				continue;
			}

			const matchVenueValue = best.metadata?.venue;
			const matchVenue = typeof matchVenueValue === "string" ? matchVenueValue : undefined;
			if (!matchVenue || matchVenue === source.venue) {
				continue;
			}

			console.log(`[${logPrefix}] potential cross-venue match`, {
				sourceVenue: source.venue,
				sourceId: vector.id,
				matchVenue,
				matchId: best.id,
				score: best.score,
			});
		} catch (error) {
			console.error(`[${logPrefix}] vector match query failed`, {
				id: vector.id,
				error,
			});
		}
	}
}
