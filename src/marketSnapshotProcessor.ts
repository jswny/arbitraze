import {
	buildEmbeddingDocument,
	buildVectorMetadata,
	type MarketMetadata,
} from "./marketMetadata";

interface ProcessMarketSnapshotOptions<T> {
	logPrefix: string;
	extractMetadata: (message: Message<T>) => MarketMetadata | undefined;
	onSkip?: (message: Message<T>) => void;
}

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

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

	const response = await ai.run(EMBEDDING_MODEL, {
		text: documents.map((item) => item.text),
	});

	const vectors: VectorizeVector[] = [];
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
	}

	if (vectors.length === 0) {
		console.warn(`[${logPrefix}] no embeddings extracted; skip upsert`);
		return;
	}

	await vectorize.upsert(vectors);
	console.log(`[${logPrefix}] upserted ${vectors.length} vector(s) into Vectorize`);
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
