import {
	FetchPolymarketMarketsOptions,
	PolymarketClient,
	PolymarketClientOptions,
	PolymarketMarketSnapshot,
} from "./polymarketClient";

const QUEUE_BATCH_SIZE = 20;

export interface PolymarketIngestBindings {
	POLYMARKET_API_BASE?: string;
}

export interface PolymarketSnapshotMessage {
	venue: "polymarket";
	captured_at: string;
	ingest_id: string;
	market: PolymarketMarketSnapshot["market"];
	raw: PolymarketMarketSnapshot["raw"];
}

export interface PolymarketSnapshotQueueBindings {
	POLYMARKET_SNAPSHOTS_QUEUE: Queue<PolymarketSnapshotMessage>;
}

export async function fetchPolymarketMarketSnapshots(
	options?: FetchPolymarketMarketsOptions,
	clientOptions?: PolymarketClientOptions,
): Promise<PolymarketMarketSnapshot[]> {
	const client = new PolymarketClient(clientOptions);
	return client.fetchMarketSnapshots(options);
}

export async function runPolymarketIngest(
	env: PolymarketIngestBindings & PolymarketSnapshotQueueBindings,
	controller: ScheduledController,
	options?: FetchPolymarketMarketsOptions,
): Promise<void> {
	const startedAt = new Date();
	const ingestId = typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	console.log(
		`[PolymarketIngest] run start ts=${startedAt.toISOString()} cron="${controller.cron ?? "manual"}" ingest_id=${ingestId}`,
	);

	try {
		const snapshots = await fetchPolymarketMarketSnapshots(options, {
			apiBaseUrl: env.POLYMARKET_API_BASE,
		});
		console.log(`[PolymarketIngest] fetched ${snapshots.length} market(s)`);

		if (snapshots.length === 0) {
			return;
		}

		const queue = env.POLYMARKET_SNAPSHOTS_QUEUE;

		const capturedAt = new Date().toISOString();
		const batches = chunk(snapshots, QUEUE_BATCH_SIZE);
		for (const batch of batches) {
			const messages = batch.map((snapshot) => ({
				body: {
					venue: "polymarket" as const,
					captured_at: capturedAt,
					ingest_id: ingestId,
					market: snapshot.market,
					raw: snapshot.raw,
				},
			}));
			await queue.sendBatch(messages);
		}

		console.log(
			`[PolymarketIngest] completed ingest_id=${ingestId} batches=${batches.length} total=${snapshots.length}`,
		);
	} catch (error) {
		console.error("[PolymarketIngest] run failed", error);
		throw error;
	}
}

function chunk<T>(items: T[], size: number): T[][] {
	if (size <= 0) {
		return [items];
	}
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}
