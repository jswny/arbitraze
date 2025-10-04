import { importPkcs8PrivateKey, signRsaPssBase64 } from "./crypto";
import { normalizePrice, roundTo } from "./spreadUtils";

const WS_PATH = "/trade-api/ws/v2";
const REST_BASE_PATH = "/trade-api/v2";
const DEMO_HTTP_BASE = "https://demo-api.kalshi.co";
const PROD_HTTP_BASE = "https://api.elections.kalshi.com";
const DEMO_WS_URL = "wss://demo-api.kalshi.co" + WS_PATH;
const PROD_WS_URL = "wss://api.elections.kalshi.com" + WS_PATH;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;
const WS_OPEN_TIMEOUT_MS = 10_000;
const MESSAGE_PREVIEW_LIMIT = 512;
const SUBSCRIBE_RESERVED_KEYS = new Set(["channels", "ok", "status", "ack"]);

export interface KalshiBindings {
	KALSHI_ACCESS_KEY_ID: string;
	KALSHI_PRIVATE_KEY: string;
	KALSHI_ENV?: string;
}

type KalshiCommandName =
	| "subscribe"
	| "unsubscribe"
	| "list_subscriptions"
	| "update_subscription";

interface KalshiCommandPayload {
	id: number;
	cmd: KalshiCommandName;
	params?: Record<string, unknown>;
}

interface PendingRequest {
	command: KalshiCommandName;
	params?: Record<string, unknown>;
	filters?: Record<string, unknown>;
	resolve: (message: KalshiServerMessage) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	sentAt: number;
}

interface DesiredSubscription {
	channel: string;
	params: Record<string, unknown>;
}

export interface KalshiSubscriptionState {
	sid: number;
	channel: string;
	params: Record<string, unknown>;
	createdAt: number;
	lastSeq?: number;
	lastMessageType?: string | null;
	lastMessageAt?: number;
	lastMessagePreview?: string;
}

export interface KalshiClientStatus {
	connected: boolean;
	readyState: number;
	lastConnectAttempt: number;
	reconnectScheduled: boolean;
	reconnectDelayMs: number;
	connecting: boolean;
	lastError: string | null;
	endpoint: string;
	pendingRequests: number;
	desiredSubscriptions: DesiredSubscription[];
	subscriptions: KalshiSubscriptionState[];
	lastMessageAt: number | null;
	lastMessageType: string | null;
	lastMessagePreview: string | null;
}

export interface SubscribeResult {
	ack: KalshiServerMessage;
}

export interface LiveMarket {
	ticker: string;
	yesBid?: number;
	yesAsk?: number;
	yesPrice?: number;
	noBid?: number;
	noAsk?: number;
	noPrice?: number;
	lastTradeTime?: number;
	volume24h?: number;
	marketId?: string;
	eventTicker?: string;
}

export interface KalshiMarketSnapshot {
	market: LiveMarket;
	raw: Record<string, unknown>;
}

export interface KalshiServerMessage {
	id?: number;
	sid?: number;
	seq?: number;
	type?: string;
	msg?: Record<string, unknown>;
	[channel: string]: unknown;
}

export class KalshiClient {
	private socket?: WebSocket;
	private connectPromise?: Promise<void>;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
	private signingKeyPromise?: Promise<CryptoKey>;
	private lastError?: string;
	private lastConnectAttempt = 0;
	private nextMessageId = 1;
	private pendingRequests = new Map<number, PendingRequest>();
	private desiredSubscriptions = new Map<string, DesiredSubscription>();
	private subscriptions = new Map<number, KalshiSubscriptionState>();
	private sidToDesiredKey = new Map<number, string>();
	private lastMessageAt = 0;
	private lastMessageType?: string;
	private lastMessagePreview?: string;
	private messageListeners = new Set<(message: KalshiServerMessage) => void>();

	constructor(private readonly env: KalshiBindings) {}

	async start(): Promise<void> {
		try {
			await this.ensureConnected();
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			console.error("[Kalshi] initial connection failed", error);
		}
	}

	async ensureConnected(): Promise<void> {
		if (this.socket && this.socket.readyState === WebSocket.OPEN) {
			return;
		}

		if (this.connectPromise) {
			return this.connectPromise;
		}

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}

		this.connectPromise = this.connectInternal();

		try {
			await this.connectPromise;
		} finally {
			this.connectPromise = undefined;
		}
	}

	async getStatus(): Promise<KalshiClientStatus> {
		const readyState = this.socket?.readyState ?? -1;
		return {
			connected: readyState === WebSocket.OPEN,
			readyState,
			lastConnectAttempt: this.lastConnectAttempt,
			reconnectScheduled: this.reconnectTimer !== undefined,
			reconnectDelayMs: this.reconnectDelay,
			connecting: this.connectPromise !== undefined,
			lastError: this.lastError ?? null,
			endpoint: this.getEndpoint(),
			pendingRequests: this.pendingRequests.size,
			desiredSubscriptions: Array.from(this.desiredSubscriptions.values()),
			subscriptions: Array.from(this.subscriptions.values()),
			lastMessageAt: this.lastMessageAt || null,
			lastMessageType: this.lastMessageType ?? null,
			lastMessagePreview: this.lastMessagePreview ?? null,
		};
	}

	async fetchLiveMarketSnapshots(
		limit = 200,
		maxPages = 3,
	): Promise<KalshiMarketSnapshot[]> {
		const snapshots: KalshiMarketSnapshot[] = [];
		const seen = new Set<string>();
		for (let page = 0; page < maxPages; page += 1) {
			const search = new URLSearchParams({
				limit: String(limit),
				offset: String(page * limit),
			});
			const path = `${REST_BASE_PATH}/markets?${search.toString()}`;
			const url = `${this.getHttpBase()}${path}`;
			const headers = await this.buildAuthHeaders("GET", path);

			const response = await fetch(url, { headers });
			if (!response.ok) {
				const text = await response.text();
				throw new Error(
					`Kalshi markets fetch failed: status=${response.status} body="${text.slice(0, 256)}"`,
				);
			}

			const data = (await response.json()) as Record<string, unknown> | undefined;
			const marketsRaw = Array.isArray(data?.markets) ? (data!.markets as unknown[]) : [];
			if (!marketsRaw.length) {
				break;
			}
			for (const market of marketsRaw) {
				if (!market) continue;
				const record = market as Record<string, unknown>;
				const status = typeof record.trading_status === "string" ? record.trading_status : undefined;
				if (status && status.toLowerCase() !== "live") continue;

				const normalized = this.normalizeMarketRecord(record);
				if (!normalized) continue;
				if (seen.has(normalized.ticker)) continue;
				seen.add(normalized.ticker);
				snapshots.push({ market: normalized, raw: record });
			}

			if (marketsRaw.length < limit) {
				break;
			}
		}

		return snapshots;
	}

	async fetchLiveTickers(
		limit = 200,
		minVolume = 1,
		maxAgeSeconds = 3600,
		maxPages = 3,
): Promise<LiveMarket[]> {
		const snapshots = await this.fetchLiveMarketSnapshots(limit, maxPages);
		const cutoffMs = maxAgeSeconds > 0 ? Date.now() - maxAgeSeconds * 1000 : undefined;
		const filtered = snapshots
			.map((snapshot) => snapshot.market)
			.filter((market) => {
				if (market.volume24h !== undefined && market.volume24h < minVolume) {
					return false;
				}
				if (
					cutoffMs !== undefined &&
					market.lastTradeTime !== undefined &&
					market.lastTradeTime < cutoffMs
				) {
					return false;
				}
				const { yesBid, yesAsk } = market;
				if (yesBid === undefined || yesAsk === undefined) {
					return false;
				}
				if (yesBid <= 0 && yesAsk >= 1) {
					return false;
				}
				return true;
			});

		filtered.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
		return filtered;
	}

	listSubscriptions(): { subscriptions: KalshiSubscriptionState[]; desired: DesiredSubscription[] } {
		return {
			subscriptions: Array.from(this.subscriptions.values()),
			desired: Array.from(this.desiredSubscriptions.values()),
		};
	}

	addMessageListener(listener: (message: KalshiServerMessage) => void): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	async subscribe(channel: string, filters: Record<string, unknown>): Promise<SubscribeResult> {
		const sanitizedFilters = this.sanitizeSubscriptionFilters(filters);
		const desired: DesiredSubscription = { channel, params: sanitizedFilters };
		const key = this.buildSubscriptionKey(desired);
		if (this.desiredSubscriptions.has(key) && this.hasSidForKey(key)) {
			return {
				ack: {
					type: "noop",
					msg: { message: "already subscribed" },
				},
			};
		}

		const params = { channels: [channel], ...sanitizedFilters };
		const ack = await this.sendCommand("subscribe", params, { filters: sanitizedFilters });
		return { ack };
	}

	private async connectInternal(): Promise<void> {
		this.lastConnectAttempt = Date.now();
		const endpoint = this.getEndpoint();
		console.log(`[Kalshi] connect attempt env=${this.env.KALSHI_ENV ?? "production"}`);
		const headers = await this.buildAuthHeaders("GET", WS_PATH);

		console.log(`[Kalshi] connecting to ${endpoint}`);

		const upgradeUrl = endpoint.replace(/^ws/i, "http");
		const req = new Request(upgradeUrl, {
			headers: {
				...headers,
				Upgrade: "websocket",
				Connection: "Upgrade",
			},
			method: "GET",
		});

		const resp = await fetch(req);
		const ws = resp.webSocket;
		if (!ws) {
			const body = await resp.text();
			throw new Error(
				`Kalshi WebSocket upgrade failed: status=${resp.status} body="${body.slice(0, 256)}"`,
			);
		}

		if ("binaryType" in ws) {
			(ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
		}
		ws.accept();

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timeout = setTimeout(() => {
				settled = true;
				reject(new Error("WebSocket open timeout"));
			}, WS_OPEN_TIMEOUT_MS);

			if (ws.readyState === WebSocket.OPEN) {
				settled = true;
				clearTimeout(timeout);
				resolve();
				return;
			}

			const handleOpen = () => {
				if (settled) return;
				settled = true;
				cleanup();
				clearTimeout(timeout);
				resolve();
			};

			const handleError = (event: Event) => {
				if (settled) return;
				settled = true;
				cleanup();
				clearTimeout(timeout);
				const details = describeErrorEvent(event);
				reject(new Error(`WebSocket error before open: ${details}`));
			};

			const handleClose = (event: CloseEvent) => {
				if (settled) return;
				settled = true;
				cleanup();
				clearTimeout(timeout);
				reject(
					new Error(
						`WebSocket closed before open: code=${event.code} reason="${event.reason}"`,
					),
				);
			};

			const cleanup = () => {
				ws.removeEventListener("open", handleOpen);
				ws.removeEventListener("error", handleError);
				ws.removeEventListener("close", handleClose);
			};

			ws.addEventListener("open", handleOpen);
			ws.addEventListener("error", handleError);
			ws.addEventListener("close", handleClose);
		});

		this.installSocketHandlers(ws);
		setTimeout(() => {
			this.resubscribeDesired().catch((error) =>
				console.error("[Kalshi] failed to resubscribe after connect", error),
			);
		}, 0);
	}

	private installSocketHandlers(ws: WebSocket) {
		this.socket = ws;
		this.lastError = undefined;
		this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

		const handleMessage = (event: MessageEvent) => {
			try {
				this.handleSocketMessage(event);
			} catch (error) {
				console.error("[Kalshi] failed to process message", error);
			}
		};

		const handleClose = (event: CloseEvent) => {
			console.warn(
				`[Kalshi] socket closed code=${event.code} reason="${event.reason}" wasClean=${event.wasClean}`,
			);
			if (this.socket === ws) {
				this.socket = undefined;
				this.failAllPending(
					`Socket closed: code=${event.code} reason="${event.reason}"`,
				);
				this.resetActiveSubscriptions();
				this.scheduleReconnect();
			}
			ws.removeEventListener("message", handleMessage);
			ws.removeEventListener("error", handleError);
			ws.removeEventListener("close", handleClose);
		};

		const handleError = (event: Event) => {
			const details = describeErrorEvent(event);
			console.error("[Kalshi] socket error", details);
			this.lastError = details;
			if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
				try {
					ws.close();
				} catch (error) {
					console.error("[Kalshi] failed to close socket after error", error);
				}
			}
		};

		ws.addEventListener("message", handleMessage);
		ws.addEventListener("close", handleClose);
		ws.addEventListener("error", handleError);
	}

	private scheduleReconnect() {
		if (this.connectPromise || this.reconnectTimer) {
			return;
		}

		const delay = this.reconnectDelay;
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);

		console.log(`[Kalshi] scheduling reconnect in ${delay}ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.ensureConnected().catch((error) => {
				this.lastError = error instanceof Error ? error.message : String(error);
				console.error("[Kalshi] reconnect failed", error);
				this.scheduleReconnect();
			});
		}, delay);
	}

	private getEndpoint(): string {
		const mode = this.env.KALSHI_ENV?.toLowerCase() ?? "production";
		return mode === "demo" ? DEMO_WS_URL : PROD_WS_URL;
	}

	private getHttpBase(): string {
		const mode = this.env.KALSHI_ENV?.toLowerCase() ?? "production";
		return mode === "demo" ? DEMO_HTTP_BASE : PROD_HTTP_BASE;
	}

	private normalizeMarketRecord(record: Record<string, unknown>): LiveMarket | undefined {
		const ticker = typeof record.ticker === "string" ? record.ticker.trim() : undefined;
		if (!ticker) {
			return undefined;
		}

		const yesPrice = normalizePrice(record.yes_price ?? record.last_price);
		const noPrice = normalizePrice(record.no_price);
		let yesBid = normalizePrice(record.yes_bid);
		let yesAsk = normalizePrice(record.yes_ask);
		let noBid = normalizePrice(record.no_bid);
		let noAsk = normalizePrice(record.no_ask);
		const volume24h = normalizeNumber(record.volume_24h);
		const lastTradeTime = normalizeTimestamp(record.last_trade_time ?? record.last_price_time);
		const marketIdRaw = record.id;
		const eventTicker = typeof record.event_ticker === "string" ? record.event_ticker : undefined;

		if (yesBid === undefined && typeof noAsk === "number") {
			yesBid = roundComplement(noAsk);
		}
		if (yesAsk === undefined && typeof yesPrice === "number") {
			yesAsk = yesPrice;
		}
		if (noBid === undefined && typeof yesAsk === "number") {
			noBid = roundComplement(yesAsk);
		}
		if (noAsk === undefined && typeof noPrice === "number") {
			noAsk = noPrice;
		}

		const marketId =
			typeof marketIdRaw === "string"
				? marketIdRaw
				: typeof marketIdRaw === "number"
					? String(marketIdRaw)
					: undefined;

		return {
			ticker,
			yesBid,
			yesAsk,
			yesPrice,
			noBid,
			noAsk,
			noPrice,
			lastTradeTime,
			volume24h,
			marketId,
			eventTicker,
		};
	}

	private async buildAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
		const timestamp = Date.now().toString();
		const signature = await this.sign(`${timestamp}${method.toUpperCase()}${path}`);

		return {
			"KALSHI-ACCESS-KEY": this.env.KALSHI_ACCESS_KEY_ID,
			"KALSHI-ACCESS-SIGNATURE": signature,
			"KALSHI-ACCESS-TIMESTAMP": timestamp,
		};
	}

	private failAllPending(reason: string) {
		for (const [id, pending] of this.pendingRequests.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(reason));
			this.pendingRequests.delete(id);
		}
	}

	private resetActiveSubscriptions() {
		this.subscriptions.clear();
		this.sidToDesiredKey.clear();
	}

	private async sign(message: string): Promise<string> {
		const key = await this.getSigningKey();
		return signRsaPssBase64(key, message);
	}

	private getSigningKey(): Promise<CryptoKey> {
		if (!this.signingKeyPromise) {
			this.signingKeyPromise = importPkcs8PrivateKey(this.env.KALSHI_PRIVATE_KEY);
		}
		return this.signingKeyPromise;
	}

	private handleSocketMessage(event: MessageEvent) {
		const now = Date.now();
		if (typeof event.data !== "string") {
			const size = (event.data as ArrayBuffer | undefined)?.byteLength ?? 0;
			console.warn(`[Kalshi] received non-text message (${size} bytes)`);
			this.lastMessageAt = now;
			this.lastMessageType = "binary";
			this.lastMessagePreview = `[binary ${size} bytes]`;
			return;
		}

		const text = event.data;
		this.lastMessageAt = now;
		this.lastMessagePreview = text.slice(0, MESSAGE_PREVIEW_LIMIT);

		let message: KalshiServerMessage;
		try {
			message = JSON.parse(text);
		} catch (error) {
			console.error("[Kalshi] failed to parse message", error, text.slice(0, 256));
			this.lastMessageType = "parse_error";
			return;
		}

		this.lastMessageType = typeof message.type === "string" ? message.type : undefined;
		this.processServerMessage(message);
	}

	private processServerMessage(message: KalshiServerMessage) {
		const type = message.type ?? "";
		if (type === "subscribed") {
			// handled during pending resolution where filters are known
		} else if (type === "unsubscribed" && typeof message.sid === "number") {
			this.unregisterSubscription(message.sid, "server");
		} else if (type === "error") {
			const summary = extractErrorSummary(message);
			console.error(`[Kalshi] server error: ${summary}`);
		}

		if (typeof message.sid === "number") {
			this.refreshSubscriptionActivity(message.sid, type, message);
		}

		this.resolvePending(message);

		if (this.messageListeners.size > 0) {
			for (const listener of this.messageListeners) {
				try {
					listener(message);
				} catch (error) {
					console.error("[Kalshi] message listener failed", error);
				}
			}
		}
	}

	private resolvePending(message: KalshiServerMessage) {
		if (typeof message.id !== "number") {
			return;
		}

		const pending = this.pendingRequests.get(message.id);
		if (!pending) {
			return;
		}

		this.pendingRequests.delete(message.id);
		clearTimeout(pending.timeout);

		if (message.type === "error") {
			const summary = extractErrorSummary(message);
			this.applyPendingErrorEffects(pending, summary);
			pending.reject(new Error(summary));
			return;
		}

		this.applyPendingSuccessEffects(pending, message);
		pending.resolve(message);
	}

	private applyPendingSuccessEffects(
		pending: PendingRequest,
		message: KalshiServerMessage,
	) {
		if (pending.command === "subscribe") {
			const channel = this.extractChannelFromPending(pending, message);
			const filters = pending.filters ?? this.extractSubscriptionFilters(channel, pending.params);
			const sid = extractSid(message);
			if (!channel || sid === undefined) {
				console.warn("[Kalshi] subscribe ack missing channel or sid", { message, pending });
				return;
			}
			this.registerSubscriptionState(sid, channel, filters);
		}
	}

	private applyPendingErrorEffects(pending: PendingRequest, summary: string) {
		if (pending.command === "subscribe") {
			console.error(`[Kalshi] subscribe command failed: ${summary}`);
		}
	}

	private extractChannelFromPending(
		pending: PendingRequest,
		message: KalshiServerMessage,
	): string | undefined {
		const paramsChannels = pending.params?.channels;
		if (Array.isArray(paramsChannels)) {
			const first = paramsChannels[0];
			if (typeof first === "string") {
				return first;
			}
		}

		const msgChannel = message.msg?.channel;
		if (typeof msgChannel === "string") {
			return msgChannel;
		}
		return undefined;
	}

	private registerSubscriptionState(
		sid: number,
		channel: string,
		filters: Record<string, unknown> = {},
	) {
		const sanitizedFilters = this.sanitizeSubscriptionFilters(filters);
		const desired: DesiredSubscription = { channel, params: sanitizedFilters };
		const key = this.buildSubscriptionKey(desired);
		this.unlinkSidForKey(key);
		this.desiredSubscriptions.set(key, desired);
		this.sidToDesiredKey.set(sid, key);
		this.subscriptions.set(sid, {
			sid,
			channel,
			params: sanitizedFilters,
			createdAt: Date.now(),
		});
		console.log(`[Kalshi] subscribed sid=${sid} channel=${channel}`);
	}

	private unregisterSubscription(sid: number, reason: string) {
		const key = this.sidToDesiredKey.get(sid);
		this.sidToDesiredKey.delete(sid);
		const existed = this.subscriptions.delete(sid);
		if (key && !this.hasSidForKey(key)) {
			// Keep desiredSubscriptions so we can resubscribe after reconnect
		}
		if (existed) {
			console.log(`[Kalshi] unsubscribed sid=${sid} reason=${reason}`);
		}
	}

	private findActiveSidForKey(key: string): number | undefined {
		for (const [sid, existingKey] of this.sidToDesiredKey.entries()) {
			if (existingKey === key) {
				return sid;
			}
		}
		return undefined;
	}

	private hasSidForKey(key: string): boolean {
		return this.findActiveSidForKey(key) !== undefined;
	}

	private unlinkSidForKey(key: string) {
		for (const [sid, existingKey] of this.sidToDesiredKey.entries()) {
			if (existingKey === key) {
				this.sidToDesiredKey.delete(sid);
				this.subscriptions.delete(sid);
			}
		}
	}

	private sanitizeSubscriptionFilters(
		filters: Record<string, unknown> = {},
	): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(filters)) {
			if (SUBSCRIBE_RESERVED_KEYS.has(key)) continue;
			const normalized = normalizeFilterValue(value);
			if (normalized !== undefined) {
				result[key] = normalized;
			}
		}
		return result;
	}

	private buildSubscriptionKey(desired: DesiredSubscription): string {
		const sortedKeys = Object.keys(desired.params).sort();
		const parts = sortedKeys.map((key) => `${key}=${JSON.stringify(desired.params[key])}`);
		return `${desired.channel}|${parts.join("&")}`;
	}

	private extractSubscriptionFilters(
		channel: string | undefined,
		params?: Record<string, unknown>,
	): Record<string, unknown> {
		if (!channel || !params) {
			return {};
		}
		return this.sanitizeSubscriptionFilters(params);
	}

	private refreshSubscriptionActivity(
		sid: number,
		type: string,
		message: KalshiServerMessage,
	) {
		const subscription = this.subscriptions.get(sid);
		if (!subscription) {
			return;
		}
		subscription.lastMessageAt = Date.now();
		subscription.lastMessageType = type ?? subscription.lastMessageType ?? null;
		if (typeof message.seq === "number") {
			subscription.lastSeq = message.seq;
		}
		const payload = message.msg ?? message;
		try {
			subscription.lastMessagePreview = JSON.stringify(payload).slice(0, MESSAGE_PREVIEW_LIMIT);
		} catch (error) {
			subscription.lastMessagePreview = `[unserializable payload]`;
		}
	}

	private async resubscribeDesired() {
		if (!this.desiredSubscriptions.size) {
			return;
		}

		console.log(`[Kalshi] resubscribing ${this.desiredSubscriptions.size} subscriptions`);
		for (const desired of this.desiredSubscriptions.values()) {
			const params = {
				channels: [desired.channel],
				...desired.params,
			};
			try {
				await this.sendCommand("subscribe", params, { filters: desired.params });
			} catch (error) {
				console.error(
					`[Kalshi] failed to resubscribe channel=${desired.channel}`,
					error,
				);
			}
		}
	}

	private async sendCommand(
		command: KalshiCommandName,
		params: Record<string, unknown>,
		options: { filters?: Record<string, unknown> } = {},
	): Promise<KalshiServerMessage> {
		await this.ensureConnected();
		const ws = this.socket;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			throw new Error("Kalshi WebSocket not open");
		}

		const id = this.nextMessageId++;
		const payload: KalshiCommandPayload = { id, cmd: command, params };
		const json = JSON.stringify(payload);
		console.log(`[Kalshi] -> ${command} id=${id}`);
		try {
			ws.send(json);
		} catch (error) {
			throw new Error(
				`Failed to send command ${command}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		return new Promise<KalshiServerMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (!this.pendingRequests.has(id)) {
					return;
				}
				this.pendingRequests.delete(id);
				reject(new Error(`Kalshi command ${command} timed out after ${COMMAND_TIMEOUT_MS}ms`));
			}, COMMAND_TIMEOUT_MS);

			this.pendingRequests.set(id, {
				command,
				params,
				filters: options.filters,
				resolve,
				reject,
				timeout,
				sentAt: Date.now(),
			});
		});
	}
}

function extractSid(message: KalshiServerMessage): number | undefined {
	if (typeof message.sid === "number") {
		return message.sid;
	}
	const msgSid = message.msg?.sid;
	if (typeof msgSid === "number") {
		return msgSid;
	}
	return undefined;
}

function roundComplement(value: number): number {
	return roundTo(1 - value, 6);
}

function normalizeNumber(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
	if (typeof value === "number") {
		return value * 1000; // Kalshi returns seconds
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isNaN(parsed) ? undefined : parsed * 1000;
	}
	return undefined;
}

function normalizeFilterValue(value: unknown): unknown {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (Array.isArray(value)) {
		const normalized = value
			.map((item) => (typeof item === "string" ? item : item != null ? String(item) : undefined))
			.filter((item): item is string => typeof item === "string");
		const deduped = Array.from(new Set(normalized));
		deduped.sort();
		return deduped;
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "object") {
		return JSON.parse(JSON.stringify(value));
	}
	return undefined;
}

function extractErrorSummary(message: KalshiServerMessage): string {
	if (message.msg && typeof message.msg === "object") {
		const err = message.msg.error ?? message.msg.message ?? message.msg.reason;
		if (typeof err === "string") {
			return err;
		}
	}
	if (typeof message.type === "string") {
		return message.type;
	}
	return "unknown error";
}

function describeErrorEvent(event: Event): string {
	if (typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent) {
		const parts = [`message=${JSON.stringify(event.message)}`];
		if (event.error) {
			parts.push(`error=${String(event.error)}`);
		}
		if (event.filename) {
			parts.push(`filename=${event.filename}`);
		}
		if (typeof event.lineno === "number") {
			parts.push(`lineno=${event.lineno}`);
		}
		if (typeof event.colno === "number") {
			parts.push(`colno=${event.colno}`);
		}
		return `ErrorEvent(${parts.join(" ")})`;
	}
	return event.toString();
}
