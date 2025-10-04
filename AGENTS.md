# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains all Worker code. Durable Objects live in `src/index.ts`; shared modules include `src/kalshiClient.ts` (WebSocket transport/state) and `src/crypto.ts` (PKCS#8 + RSA-PSS helpers).
- Configuration lives at the repo root (`wrangler.jsonc`, `.dev.vars`). Runtime type definitions are in `worker-configuration.d.ts`.
- No test directory yet; place future integration smoke tests under `tests/` and Miniflare fixtures under `tests/fixtures/`.

## Build, Test, and Development Commands
- `pnpm install` (or `npm install`) installs Worker dependencies.
- `pnpm dev` → `wrangler dev` with live reload; uses `.dev.vars` secrets.
- `pnpm dev` now auto-creates `.wrangler/logs/`, sets `WRANGLER_LOG_PATH` to that directory, and runs `wrangler dev --test-scheduled` so cron handlers fire during local runs. When remote agents need a dev run, ask the user to execute it locally rather than running Wrangler directly from the agent session. Once Wrangler prints `Ready on http://localhost:PORT`, trigger the scheduled ingest manually with `curl -X POST "http://localhost:PORT/__scheduled?cron=*/5%20*%20*%20*%20*"`. In current workflows `PORT` defaults to `8787`, so you can assume `http://localhost:8787` unless the user specifies otherwise.
- `pnpm deploy` → `wrangler deploy` to push the worker and Durable Object.
- `pnpm cf-typegen` refreshes `worker-configuration.d.ts` after binding changes.
- `pnpm typecheck` runs `tsc --noEmit` for a quick type-only pass (alias retained so agents don’t have to remember the long command).

## Coding Style & Naming Conventions
- TypeScript throughout; prefer ES module syntax and explicit `export` lists.
- Two-space indentation, trailing commas in multi-line literals, and snake_case for Kalshi channel keys.
- Centralize secrets and configuration as typed bindings in `Env` extensions; avoid hard-coded credentials.
- Keep Durable Object methods concise; push protocol logic into `src/kalshiClient.ts` or smaller modules.

## Testing Guidelines
- Add Worker integration tests with Miniflare (`@cloudflare/workers-types` + `vitest` recommended). Name files `*.test.ts` under `tests/`.
- Include mocked Kalshi WebSocket transcripts to validate subscribe/ack flows.
- Aim for basic coverage on reconnect logic and command timeouts before enabling live trading.

## Commit & Pull Request Guidelines
- Follow Conventional Commit prefixes (`feat:`, `fix:`, `chore:`) as seen in history. Scope modules when useful (e.g., `feat(kalshi): add resubscribe handling`).
- Pull requests should describe behavior changes, note any new bindings/secrets, and include manual test output (`wrangler dev` logs or curl examples). Link Jira/GitHub issues when applicable.
- Request review before merging; ensure CI (type check/tests) passes locally if no pipeline runs yet.

## Security & Configuration Tips
- Store API credentials via Wrangler secrets (`wrangler secret put`) and `.dev.vars` for local dev; never commit keys.
- Require PKCS#8 (`BEGIN PRIVATE KEY`) secrets—convert with `ssh-keygen -p -m PEM -f key.pem` before adding.
- Keep reconnect backoff limits conservative to avoid hammering Kalshi during incidents.
