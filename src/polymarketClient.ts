import {
	pickBoolean,
	pickIsoTimestamp,
	pickNumber,
	pickString,
	toRecord,
} from "./utils/records";

const DEFAULT_API_BASE = "https://gamma-api.polymarket.com";
const MARKETS_PATH = "/markets";
const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_PAGES = 5;

export interface PolymarketClientOptions {
	readonly apiBaseUrl?: string;
}

export interface FetchPolymarketMarketsOptions {
	readonly limit?: number;
	readonly maxPages?: number;
	readonly activeOnly?: boolean;
	readonly includeClosed?: boolean;
	readonly minVolume24h?: number;
}

export interface PolymarketMarketSnapshot {
	market: PolymarketMarket;
	raw: Record<string, unknown>;
}

export interface PolymarketMarket {
	id: string;
	slug: string;
	question?: string;
	description?: string;
	conditionId?: string;
	resolutionSource?: string;
	category?: string;
	groupTitle?: string;
	outcomes?: string[];
	outcomePrices?: number[];
	startTime?: string;
	endTime?: string;
	createdAt?: string;
	updatedAt?: string;
	volume?: number;
	volume24h?: number;
	liquidity?: number;
	lastTradePrice?: number;
	bestBid?: number;
	bestAsk?: number;
	restricted?: boolean;
	eventId?: string;
	eventSlug?: string;
	eventTitle?: string;
	eventDescription?: string;
	eventStartTime?: string;
	eventEndTime?: string;
	eventCategory?: string;
	seriesId?: string;
	seriesSlug?: string;
	seriesTitle?: string;
	seriesType?: string;
}

export class PolymarketClient {
	private readonly apiBase: string;

	constructor(options: PolymarketClientOptions = {}) {
		this.apiBase = options.apiBaseUrl ?? DEFAULT_API_BASE;
	}

	async fetchMarketSnapshots(
		options: FetchPolymarketMarketsOptions = {},
	): Promise<PolymarketMarketSnapshot[]> {
		const {
			limit = DEFAULT_LIMIT,
			maxPages = DEFAULT_MAX_PAGES,
			activeOnly = true,
			includeClosed = false,
			minVolume24h,
		} = options;

		const snapshots: PolymarketMarketSnapshot[] = [];
		const seen = new Set<string>();

		for (let page = 0; page < maxPages; page += 1) {
			const offset = page * limit;
			const params = new URLSearchParams();
			params.set("limit", String(limit));
			if (offset > 0) {
				params.set("offset", String(offset));
			}
			params.set("order", "volume24hr");
			params.set("ascending", "false");
			if (activeOnly) {
				params.set("active", "true");
			}
			if (!includeClosed) {
				params.set("closed", "false");
			}

			const url = `${this.apiBase}${MARKETS_PATH}?${params.toString()}`;
			const response = await fetch(url, {
				headers: {
					accept: "application/json",
				},
			});
			if (!response.ok) {
				const body = await response.text();
				throw new Error(
					`Polymarket markets fetch failed: status=${response.status} body="${body.slice(0, 256)}"`,
				);
			}

			const data = (await response.json()) as unknown;
			const markets = Array.isArray(data) ? data : [];
			if (markets.length === 0) {
				break;
			}

			for (const item of markets) {
				const rawRecord = toRecord(item);
				if (!rawRecord) {
					continue;
				}

				const normalized = normalizePolymarketMarket(rawRecord);
				if (!normalized) {
					continue;
				}

				if (typeof minVolume24h === "number" && normalized.volume24h !== undefined) {
					if (normalized.volume24h < minVolume24h) {
						continue;
					}
				}

				if (seen.has(normalized.id)) {
					continue;
				}
				seen.add(normalized.id);
				snapshots.push({ market: normalized, raw: rawRecord });
			}

			if (markets.length < limit) {
				break;
			}
		}

		return snapshots;
	}
}

function normalizePolymarketMarket(record: Record<string, unknown>): PolymarketMarket | undefined {
	const id = pickString(record.id) ?? pickString(record.conditionId);
	const slug = pickString(record.slug);
	if (!id || !slug) {
		return undefined;
	}

	const outcomes = parseStringArray(record.outcomes);
	const outcomePrices = parseNumberArray(record.outcomePrices);
	const startTime = pickIsoTimestamp(record.startDate);
	const endTime = pickIsoTimestamp(record.endDate);
	const createdAt = pickIsoTimestamp(record.createdAt);
	const updatedAt = pickIsoTimestamp(record.updatedAt);

	const eventRecord = pickFirstRecord(record.events);
	const seriesRecord = pickFirstRecord(eventRecord?.series);

	return {
		id,
		slug,
		question: pickString(record.question) ?? pickString(eventRecord?.title),
		description: pickString(record.description) ?? pickString(eventRecord?.description),
		conditionId: pickString(record.conditionId),
		resolutionSource: pickString(record.resolutionSource) ?? pickString(eventRecord?.resolutionSource),
		category: pickString(record.category) ?? pickString(eventRecord?.category),
		groupTitle: pickString(record.groupItemTitle),
		outcomes,
		outcomePrices,
		startTime,
		endTime,
		createdAt,
		updatedAt,
		volume: pickNumber(record.volume ?? record.volumeNum),
		volume24h: pickNumber(record.volume24hr),
		liquidity: pickNumber(record.liquidity ?? record.liquidityNum),
		lastTradePrice: pickNumber(record.lastTradePrice),
		bestBid: pickNumber(record.bestBid),
		bestAsk: pickNumber(record.bestAsk),
		restricted: pickBoolean(record.restricted),
		eventId: pickString(eventRecord?.id),
		eventSlug: pickString(eventRecord?.slug),
		eventTitle: pickString(eventRecord?.title),
		eventDescription: pickString(eventRecord?.description),
		eventStartTime: pickIsoTimestamp(eventRecord?.startDate ?? eventRecord?.startTime),
		eventEndTime: pickIsoTimestamp(eventRecord?.endDate),
		eventCategory: pickString(eventRecord?.category),
		seriesId: pickString(seriesRecord?.id),
		seriesSlug: pickString(seriesRecord?.slug ?? seriesRecord?.ticker),
		seriesTitle: pickString(seriesRecord?.title),
		seriesType: pickString(seriesRecord?.seriesType),
	};
}

function pickFirstRecord(value: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const record = toRecord(item);
			if (record) {
				return record;
			}
		}
	}
	return undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.map(pickString).filter((item): item is string => typeof item === "string");
		return items.length ? items : undefined;
	}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return parseStringArray(parsed);
		} catch (_error) {
			return undefined;
	}
	}
	return undefined;
}

function parseNumberArray(value: unknown): number[] | undefined {
	if (Array.isArray(value)) {
		const items = value
			.map(pickNumber)
			.filter((item): item is number => typeof item === "number");
		return items.length ? items : undefined;
	}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return parseNumberArray(parsed);
		} catch (_error) {
			return undefined;
		}
	}
	return undefined;
}
