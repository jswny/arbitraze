export function normalizePrice(value: unknown): number | undefined {
	const raw = normalizeRawPrice(value);
	if (raw === undefined) return undefined;
	return roundTo(raw / 100, 6);
}

export function roundTo(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function normalizeRawPrice(value: unknown): number | undefined {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	if (Array.isArray(value) && value.length > 0) {
		return normalizeRawPrice(value[0]);
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if ("price" in record) {
			return normalizeRawPrice(record.price);
		}
		if ("p" in record) {
			return normalizeRawPrice(record.p);
		}
	}
	return undefined;
}
