import { KalshiClient, KalshiBindings, KalshiMarketSnapshot } from "./kalshiClient";
import { chunk } from "./utils/batch";

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
		let total = 0;
		let batchesDispatched = 0;
		const capturedAt = new Date().toISOString();

		for await (const pageSnapshots of client.iterateLiveMarketSnapshots()) {
			if (pageSnapshots.length === 0) {
				continue;
			}

			total += pageSnapshots.length;
			const batches = chunk(pageSnapshots, QUEUE_BATCH_SIZE);
			for (const batch of batches) {
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
				batchesDispatched += 1;
			}
		}

		console.log(
			`[KalshiIngest] completed ingest_id=${ingestId} batches=${batchesDispatched} total=${total}`,
		);
	} catch (error) {
		console.error("[KalshiIngest] run failed", error);
		throw error;
	}
}
