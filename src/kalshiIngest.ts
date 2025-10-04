import { KalshiClient, KalshiBindings, KalshiMarketSnapshot } from "./kalshiClient";

export interface KalshiSnapshotQueueBindings {
	KALSHI_SNAPSHOTS_QUEUE: Queue<KalshiSnapshotMessage>;
}

export interface KalshiSnapshotMessage {
	venue: "kalshi";
	captured_at: string;
	ingest_id: string;
	market: KalshiMarketSnapshot["market"];
	raw: KalshiMarketSnapshot["raw"];
}

const QUEUE_BATCH_SIZE = 40;

export async function runKalshiIngest(
	env: KalshiBindings & KalshiSnapshotQueueBindings,
	controller: ScheduledController,
): Promise<void> {
	const startedAt = new Date();
	const ingestId = typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	console.log(
		`[KalshiIngest] run start ts=${startedAt.toISOString()} cron="${controller.cron ?? "manual"}" ingest_id=${ingestId}`,
	);

	try {
		const client = new KalshiClient(env);
		const snapshots = await client.fetchLiveMarketSnapshots();
		console.log(`[KalshiIngest] fetched ${snapshots.length} live markets`);

		if (snapshots.length === 0) {
			return;
		}

		const capturedAt = new Date().toISOString();
		const batches = chunk(snapshots, QUEUE_BATCH_SIZE);
		let batchIndex = 0;

		for (const batch of batches) {
			batchIndex += 1;
			const messages = batch.map((snapshot) => ({
				body: {
					venue: "kalshi" as const,
					captured_at: capturedAt,
					ingest_id: ingestId,
					market: snapshot.market,
					raw: snapshot.raw,
				},
			}));
			await env.KALSHI_SNAPSHOTS_QUEUE.sendBatch(messages);
		}

		console.log(
			`[KalshiIngest] completed ingest_id=${ingestId} batches=${batches.length} total=${snapshots.length}`,
		);
	} catch (error) {
		console.error("[KalshiIngest] run failed", error);
		throw error;
	}
}

function chunk<T>(items: T[], size: number): T[][] {
	if (size <= 0) return [items];
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}
