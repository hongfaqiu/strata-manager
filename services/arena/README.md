# Benchmark Arena service

Cloudflare Worker + D1 behind `https://arena.cosfoc.com`. It accepts opt-in benchmark summaries from Strata Manager and serves the leaderboard used by the app and the website.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/health` | Schema and consent version. |
| POST | `/v1/submit` | Signed. Body must match the whitelist in `src/schema.js`; unknown keys are rejected. |
| DELETE | `/v1/me` | Signed. Body `{ "installId": "..." }`; deletes every submission of that install. |
| GET | `/v1/groups` | Model + quant groups with totals. |
| GET | `/v1/leaderboard?group=&gpu=&vram=` | Rows for one group (hardware + launch parameters). |
| GET | `/v1/recommend?family=&quant=&gpu=&vram=&ram=&scene=&ctx=&kv=…` | Same-model parameter suggestions first, then other models. |

Signed requests carry `X-Arena-Ts`, `X-Arena-Nonce` and `X-Arena-Sig` = hex HMAC-SHA256 of `${ts}\n${nonce}\n${sha256hex(body)}`. Timestamps outside ±10 minutes and reused nonces are rejected. Install IDs are stored only as hashes; client IPs are only used as salted, per-day rate-limit keys.

Ranking uses each machine's median of its latest 3 runs of 8K decode; a configuration is ranked once at least 3 machines report it. Rows submitted with a valid `X-Arena-Seed` header are flagged as maintainer measurements: they are labeled in the UI, may appear below the 3-machine threshold, and are excluded from public totals. Submissions older than 12 months are removed by the hourly cron, which also rebuilds the cached aggregates.

## Development

```sh
npm test            # node:test against an in-memory D1 shim (node:sqlite)
```

## Deploy

```sh
wrangler d1 create strata-arena                 # once; put the id in wrangler.toml
npm run migrate                                 # applies migrations/ to the remote DB
wrangler secret put ARENA_APP_KEYS              # comma-separated; the first key is the one shipped in the app
wrangler secret put IP_SALT
wrangler secret put SEED_TOKEN
npm run deploy
```

The app key is embedded in the desktop build (`STRATA_ARENA_APP_KEY` at compile time) and should be treated as public: it filters casual noise, while rate limits and value sanity checks do the actual protection. Rotate by adding the new key to `ARENA_APP_KEYS`, shipping an app with it, then dropping the old one.

## Moderation

```sql
UPDATE submissions SET hidden = 1 WHERE id = '…';   -- hide a bad row; aggregates refresh on the next cron run
```
