import { DurableObject } from "cloudflare:workers";
import { KalshiClient } from "./kalshiClient";
import type { KalshiBindings } from "./kalshiClient";
import { KalshiSnapshotQueueBindings, runKalshiIngest } from "./kalshiIngest";
import type { KalshiSnapshotMessage } from "./kalshiIngest";
import { processKalshiSnapshotBatch } from "./kalshiSnapshotConsumer";

type WorkerEnv = Env & KalshiBindings & KalshiSnapshotQueueBindings;

declare global {
	interface Env extends KalshiBindings, KalshiSnapshotQueueBindings {}
}

export class KalshiWebsocketDurableObject extends DurableObject<WorkerEnv> {
	private readonly kalshi: KalshiClient;

	constructor(state: DurableObjectState, env: WorkerEnv) {
		super(state, env);
		this.kalshi = new KalshiClient(env);
		state.blockConcurrencyWhile(async () => {
			await this.kalshi.start();
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/connect") {
			await this.kalshi.ensureConnected();
			return new Response("Kalshi WebSocket connection attempt started\n", { status: 202 });
		}

		if (request.method === "POST" && url.pathname === "/subscribe") {
			return this.handleSubscribe(request);
		}

		if (request.method === "GET" && url.pathname === "/subscriptions") {
			const summary = this.kalshi.listSubscriptions();
			return json(summary);
		}

		if (url.pathname === "/status" || url.pathname === "/") {
			const status = await this.kalshi.getStatus();
			return json(status);
		}

		return new Response("Not found", { status: 404 });
	}

	private async handleSubscribe(request: Request): Promise<Response> {
		let body: unknown;
		try {
			body = await request.json();
		} catch (error) {
			return json({ ok: false, error: `Invalid JSON body: ${error}` }, 400);
		}

		if (!isRecord(body)) {
			return json({ ok: false, error: "Request body must be an object" }, 400);
		}

		const channelsValue = body.channels;
		const channels = Array.isArray(channelsValue)
			? channelsValue.filter((item): item is string => typeof item === "string")
			: [];
		const channel = (channels[0] ?? "ticker").toLowerCase();
		const normalizedChannel = channel === "order_book" ? "orderbook" : channel;
		if (normalizedChannel !== "ticker" && normalizedChannel !== "orderbook") {
			return json({ ok: false, error: `Unsupported channel: ${channel}` }, 400);
		}
		const filters = { ...body };

		try {
			const { ack } = await this.kalshi.subscribe(normalizedChannel, filters);
			const status = await this.kalshi.getStatus();
			return json({ ok: true, ack, status });
		} catch (error) {
			const status = await this.kalshi.getStatus();
			return json({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				status,
			}, 502);
		}
	}

}

	export default {
		async fetch(request: Request, env: WorkerEnv): Promise<Response> {
			const id = env.KALSHI_WEBSOCKET_DO.idFromName("kalshi-websocket");
			const stub = env.KALSHI_WEBSOCKET_DO.get(id);
			return stub.fetch(request);
		},
		async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
			ctx.waitUntil(runKalshiIngest(env, controller));
		},
		async queue(
			batch: MessageBatch<KalshiSnapshotMessage>,
			env: WorkerEnv,
			ctx: ExecutionContext,
		): Promise<void> {
			await processKalshiSnapshotBatch(batch, env, ctx);
		},
} satisfies ExportedHandler<WorkerEnv, KalshiSnapshotMessage>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}
