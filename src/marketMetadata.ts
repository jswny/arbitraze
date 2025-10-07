export interface MarketMetadata {
	id: string;
	venue: string;
	symbol?: string;
	title?: string;
	question?: string;
	description?: string;
	categories?: string[];
	startTime?: string;
	endTime?: string;
	identifiers?: Record<string, string>;
	event?: MarketEventMetadata;
}

export interface MarketEventMetadata {
	title?: string;
	category?: string;
}

export function buildEmbeddingDocument(record: MarketMetadata): string | undefined {
	const sections: string[] = [];

	sections.push(`Market ID: ${record.id}`);

	appendIfPresent(sections, "Symbol", record.symbol);

	if (record.identifiers) {
		for (const [key, value] of Object.entries(record.identifiers)) {
			appendIfPresent(sections, `Identifier (${key})`, value);
		}
	}

	appendIfPresent(sections, "Title", record.title);
	appendIfPresent(sections, "Question", record.question);
	appendIfPresent(sections, "Description", record.description);

	if (record.categories?.length) {
		sections.push(`Categories: ${uniqueStrings(record.categories).join(", ")}`);
	}
	appendIfPresent(sections, "Opens", record.startTime);
	appendIfPresent(sections, "Closes", record.endTime);

	if (record.event) {
		const { event } = record;
		const eventSections: string[] = [];
		appendIfPresent(eventSections, "Event Title", event.title);
		appendIfPresent(eventSections, "Event Category", event.category);
		if (eventSections.length) {
			sections.push(eventSections.join("\n"));
		}
	}

	const content = sections
		.map((value) => value?.trim())
		.filter((value): value is string => !!value && value.length > 0)
		.join("\n\n");

	return content.length ? content : undefined;
}

export function buildVectorMetadata(record: MarketMetadata): Record<string, VectorizeVectorMetadata> {
	const metadata: Record<string, VectorizeVectorMetadata> = {
		venue: record.venue,
	};

	assignIfPresent(metadata, "symbol", record.symbol);

	if (record.categories?.length) {
		metadata.categories = uniqueStrings(record.categories);
	}

	assignIfPresent(metadata, "startTime", record.startTime);
	assignIfPresent(metadata, "endTime", record.endTime);

	if (record.identifiers) {
		for (const [key, value] of Object.entries(record.identifiers)) {
			assignIfPresent(metadata, key, value);
		}
	}

	if (record.event) {
		const { event } = record;
		assignIfPresent(metadata, "eventTitle", event.title);
		assignIfPresent(metadata, "eventCategory", event.category);
	}

	return metadata;
}

function assignIfPresent(
	target: Record<string, VectorizeVectorMetadata>,
	key: string,
	value: string | undefined,
): void {
	const normalized = cleanString(value);
	if (!normalized) {
		return;
	}
	target[key] = normalized;
}

function appendIfPresent(target: string[], label: string, value: string | undefined): void {
	const normalized = cleanString(value);
	if (!normalized) {
		return;
	}
	target.push(`${label}: ${normalized}`);
}

function cleanString(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length ? trimmed : undefined;
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = cleanString(value);
		if (!normalized) {
			continue;
		}
		if (seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
