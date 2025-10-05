# Kalshi/Polymarket Matching Roadmap

1. Data ingestion ✅ Kalshi REST snapshots in queue
   - Run a dedicated scheduled worker (outside the Kalshi DO) that calls Kalshi REST APIs on a configurable cadence. *Done: `runKalshiIngest` runs on cron via the main worker’s scheduled handler.*
   - Publish normalized market snapshots (plus raw payload) to a provider-specific queue so the DO can stay focused on websocket traffic. *Done: Kalshi messages pushed to `kalshi-snapshots` with `captured_at` and `ingest_id` metadata; set up parallel queue bindings for future venues as they come online.*
   - Polymarket REST ingestion ✅ scheduled fetch pushes to `polymarket-snapshots`; consumer embeds markets and upserts into Vectorize with matching metadata fields.

2. Queue-driven enrichment pipeline ✅ metadata-only Kalshi batch consumer
   - Bind Cloudflare Queues per venue and fan them into a shared enrichment pipeline. *Done for Kalshi: `kalshi-snapshots` producer + consumer binding wired to the worker; additional queues will reuse the same consumer module via venue tagging.*
   - Build a consumer worker that batches queue items, adds derived metadata, and handles retries/dead-lettering. *Done: venue-specific extractors feed a shared `processMarketSnapshotBatch` helper that dedupes, enriches, and handles retries before persistence (stubbed to console for now).* 

3. Vector store integration ✅ Kalshi embeddings in Vectorize
   - Embed market titles/descriptions and write vectors plus structured fields into Cloudflare Vectorize. *Done: shared processor calls Workers AI `@cf/baai/bge-base-en-v1.5` and upserts normalized `MarketMetadata` from both venues into the `MARKET_METADATA_VECTORS` binding (Cloudflare index `arbitraze-matching-markets-dev`).*
   - Standardize venue metadata ahead of matching. *Done: Kalshi and Polymarket extractors now emit the same `MarketMetadata` contract before embedding to keep similarity scoring aligned.*
   - Store raw payloads alongside normalized fields for replay/debugging. *Planned: decide on persistence target (KV/R2/Queues) for raw snapshot storage.*

4. Market matching service
   - Implement similarity search plus rule-based validators to propose cross-venue matches.
   - Surface matches for human review before they feed trading/pricing systems.

5. Operational toolkit
   - Build dashboards or review tools to inspect matched markets, flag conflicts, and monitor sync freshness.
   - Define replay procedures so new matching logic can be applied to stored raw snapshots.
