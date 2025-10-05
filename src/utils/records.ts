export function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

export function pickString(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
}

export function pickIsoTimestamp(value: unknown): string | undefined {
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

export function pickBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		switch (value.toLowerCase()) {
			case "true":
				return true;
			case "false":
				return false;
			default:
				return undefined;
		}
	}
	return undefined;
}

export function pickNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function uniqueArray(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = pickString(value);
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
