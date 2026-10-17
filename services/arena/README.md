# Benchmark Arena service

Cloudflare Worker + D1. It accepts opt-in benchmark summaries from Strata Manager and serves the leaderboard used by the app and the website. The same Worker also hosts the website:

| Host | `/v1/*` | Everything else |
| --- | --- | --- |
| `strata-manager.cosfoc.com` | Arena API | Static website from `dist/website` (Workers static assets, `src/site.js`) |
| `arena.cosfoc.com` | Arena API (compiled into shipped apps; behavior unchanged) | `301` to the website (`/` → `/leaderboard`) |

Website routing (`wrangler.toml` `[assets]`): clean URLs (`html_handling = "auto-trailing-slash"`, so `docs/changelog.html` is served at `/docs/changelog` and the `.html` form redirects there), `404.html` for unknown paths, and the Worker runs first for everything except `/assets/*` and `/vendor/*`. Cache: HTML, sitemap and data revalidate on every visit (no file name is fingerprinted), CSS/JS 10 minutes, screenshots 1 day, vendor scripts 7 days, all with `stale-while-revalidate`; security headers (`nosniff`, `X-Frame-Options`, `frame-ancestors`, referrer and permissions policy, HSTS) come from `src/site.js` and `website/_headers`.

## API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/health` | – | Schema and consent version. |
| POST | `/v1/register/challenge` | – | Proof-of-work challenge `{ challenge, bits, expiresAt }`, valid 10 minutes, single use. |
| POST | `/v1/register` | app key + install key | Body `{ publicKey, challenge, counter, consentVersion }`. Registers an Ed25519 public key. |
| POST | `/v1/submit` | app key + install key | Body must match the whitelist in `src/schema.js`; unknown keys are rejected. Optional `evidence` (text) + `evidenceSig`, see below. Response `{ accepted, id, ranked, seed, evidence, reasons, counted }`. |
| DELETE | `/v1/me` | install key | Body `{}`. Deletes every submission of the key and the key registration. |
| GET | `/v1/groups` | – | Model + quant groups with totals (`machines` counts installs with counted runs, `pendingMachines` installs with runs that do not count). |
| GET | `/v1/leaderboard?group=&gpu=&vram=` | – | Rows for one group (hardware + launch parameters). Optional filters: `ram` (tier), `ctx`, `kv`, `parallel`, `gpuCount`, `expertCache`, `q` (GPU name keyword); `sort` = `decode8k` (default), `decode128k`, `prefill` or `machines`, ranks recomputed. The response adds `options` (distinct values per facet across the whole group), `total` and `sort`; unknown or malformed values are ignored. |
| GET | `/v1/recommend?family=&quant=&gpu=&vram=&ram=&scene=&ctx=&kv=…` | – | Same-model parameter suggestions first, then other models. |
| GET/POST | `/v1/admin/…` | `Authorization: Bearer ADMIN_TOKEN` | Maintainer endpoints, see below. |

### Signatures

Every signed request carries `X-Arena-Ts` (ms) and `X-Arena-Nonce` (32 hex). The signed message is

```
${ts}\n${nonce}\n${sha256hex(body)}
```

- **App key**: `X-Arena-Sig` = hex HMAC-SHA256 of the message with a key from `ARENA_APP_KEYS`. The key is compiled into release builds only (see below).
- **Install key**: `X-Arena-Key` = sha256hex(public key bytes) and `X-Arena-Install-Sig` = hex Ed25519 signature of the same message. On `/v1/register` the signature proves possession of the key being registered.

Timestamps outside ±10 minutes and reused nonces are rejected.

### Run evidence (`src/evidence.js`)

A context submission from the app carries `evidence`: the exact JSON text of a content-free trace of the in-app run, and `evidenceSig`: hex Ed25519 signature by the install key of

```
strata-arena-evidence|v1|${keyId}|${sha256hex(evidence)}
```

The trace is `{ v, engine, durationMs, intervalMs, runs[], series, counters }`: for each completed request (at most 48) its tier, start/end offsets from the run start, TTFT, prompt / cached / output tokens, prefill and decode speed and resource-sample count; the resource series as sample `count`, bucket `stepMs` and at most 121 buckets of peak VRAM GB, peak RAM GB and mean GPU utilization; and the engine `/metrics` `totals` (requests, prompt tokens, output tokens) before and after the run. Unknown keys are rejected (400), a bad signature too (400 `invalid_evidence_signature`). Prompts, outputs and wall-clock times cannot be represented.

`checkEvidence` then requires, with tolerances: engine version = `strata`; runs ordered, non-overlapping and inside `durationMs`; prompt tokens within 30–100 % of the tier, cached ≤ prompt, output ≥ 1; TTFT within 0.6×–4× (+5 s) of `(prompt − cached) / prefill`; wall time within 0.7×–2× of `TTFT + output / decode`; every ok tier equal (1 %) to the median of its runs and no run without a tier; `stepMs ≥ intervalMs`, bucket count = `ceil(durationMs / stepMs)` ±1, sample count ≥ the runs' samples, ≤ `durationMs / intervalMs + 3 × runs + 20`, and ≥ 30 % of busy time / interval; series peaks equal (5 % / 0.5 GB) the tier peaks and fit the GPU VRAM and host RAM; counter deltas non-negative, requests ≥ runs, prompt tokens ≥ 90 % of the uncached prompt tokens, output tokens ≥ 90 % of the reported ones (loose upper bounds allow token counting and failed attempts in between).

Passing evidence stores the run as `verified`; failing evidence as `failed` with the reasons (`evidence_reason`); none as `missing`. The stored text and signature can be re-verified later against the install's public key.

### Proof of work

The challenge is `ts.rand.bits.mac`, where `mac` is an HMAC with `POW_SECRET`, so the difficulty cannot be lowered by the client. The client finds `counter` such that

```
sha256("strata-arena-pow|" + challenge + "|" + publicKeyHex + "|" + counter)
```

has at least `bits` leading zero bits. The public key is part of the preimage, so a solution cannot be reused for another key. Difficulty is `POW_BITS` (default 22; one thread on a CPU with SHA extensions averages about 0.2 s, p90 0.5 s, older CPUs several times longer) and rises by 2 while more than `POW_SURGE` (default 30) installs registered in the last hour. Registrations are also limited to 10 per IP per day.

## Reputation (`src/trust.js`)

Every ranked submission, every withdrawal, every maintainer action and the hourly cron recompute the aggregates, so a verified run is public as soon as the upload returns:

- **A run counts** when its evidence is `verified`, it is not flagged and its install is not flagged or banned; or when a maintainer marked the install trusted. There is no waiting period and no peer requirement.
- **Pending**: runs with `missing` or `failed` evidence (including scenario runs) are stored but excluded from all public aggregates.
- **Per-run flags**, applied after the fact once peers exist: `peer_outlier` (more than 1.8× above or below the median of other machines on the same configuration: model + quant + GPU + VRAM/RAM tier + launch parameters) and `ttft_fast` (first token faster than the reported prefill speed allows). Flagged runs leave the aggregates.
- **Install status**: `banned` / `trusted` (override) / `flagged` (more than a third of 3+ runs flagged, or inconsistent with peers on most compared configurations: machine median outside `max(3.5 × 1.4826 × MAD, 12 % of median)` of 2+ peers) / `verified` (at least one verified run) / `pending`.
- **Trust score** 0–1 = `0.7 × verified share + 0.3 × peer agreement − flag rate` (agreement is neutral 0.5 without peers); maintainers only.

Rows need one counting machine; fewer than 3 are labeled `none`/`low` confidence and never drive recommendations (`MIN_MACHINES = 3` in `src/stats.js`).

Maintainer seed rows (valid `X-Arena-Seed` header) always count, are labeled in the UI and are excluded from public totals.

## Maintainer endpoints

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://arena.cosfoc.com/v1/admin/installs?status=pending   # verified | pending | flagged | trusted | banned
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://arena.cosfoc.com/v1/admin/installs/<keyId>     # details + last 200 runs with evidence status/reason
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://arena.cosfoc.com/v1/admin/submissions/<id>   # one run with its signed evidence text + public key
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"action":"ban"}' https://arena.cosfoc.com/v1/admin/installs/<keyId>
#   actions: ban | unban | trust | reset   (reset clears the override and recomputes from evidence)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"hidden":true}' https://arena.cosfoc.com/v1/admin/submissions/<id>
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://arena.cosfoc.com/v1/admin/recompute
```

A banned key cannot submit or register again. If it withdraws, its runs are deleted and only a tombstone (key id + ban) remains.

## Data and retention

Stored per install: the public key, registration and last-seen time, solved difficulty, override, computed status and trust. No IP addresses: rate-limit keys are `HMAC(IP_SALT, day + ip)`, truncated, and purged after two days. Submissions older than 12 months, and installs not seen for 12 months (except bans), are removed by the cron.

## Development

```sh
npm test            # node:test against an in-memory D1 shim (node:sqlite), with POW_BITS=8
```

## Deploy

CI deploys from `main` (`.github/workflows/website.yml`): website checks, `npm test`, `node scripts/build-website.mjs`, then **pending D1 migrations** (`wrangler d1 migrations list --remote`; `apply --remote` only when the list is not empty) and `wrangler deploy`, followed by a smoke test of both hosts. Migrations run before the new code, so they must stay additive (new tables/columns with defaults), never drop or rename what the deployed Worker still reads. Pull requests run everything up to `wrangler deploy --dry-run`.

The workflow needs one repository secret, `CLOUDFLARE_API_TOKEN` (the account id is in `wrangler.toml`): an account API token for account `6cfa9aa494be7345e6e1ca12fa386a26` with

- Account → Workers Scripts → Edit
- Account → D1 → Edit (migrations)
- Zone `cosfoc.com` → Workers Routes → Edit (the two custom domains)

```sh
gh secret set CLOUDFLARE_API_TOKEN -R hongfaqiu/strata-manager   # paste the token at the prompt
```

Manual deploy from a checkout (same steps as CI):

```sh
node scripts/build-website.mjs                  # from the repository root
cd services/arena
npx wrangler@4.151.1 d1 migrations apply strata-arena --remote
npx wrangler@4.151.1 deploy
```

First-time setup only:

```sh
wrangler d1 create strata-arena                 # once; put the id in wrangler.toml
wrangler secret put ARENA_APP_KEYS              # comma-separated; list old and new key during a rotation
wrangler secret put IP_SALT
wrangler secret put SEED_TOKEN
wrangler secret put POW_SECRET
wrangler secret put ADMIN_TOKEN
```

`POW_BITS` / `POW_SURGE` are plain vars in `wrangler.toml`; secrets are kept across deploys.

### Old GitHub Pages address

`hongfaqiu.github.io/strata-manager/` cannot send HTTP redirects. After the cutover, run the *Legacy GitHub Pages redirects* workflow once (`.github/workflows/website-legacy-redirects.yml`, manual only): it publishes one page per old URL (canonical + meta refresh + a script that keeps `?query` and `#fragment`) and a `404.html` that maps every other old path. Leave GitHub Pages enabled so they stay up.

### App key

The source tree contains no app key. CI compiles it in from the repository secret `ARENA_APP_KEY` (`STRATA_ARENA_APP_KEY` at build time, `.github/workflows/ci.yml` → *Build test installers*); release-capable runs in this repository set `STRATA_ARENA_REQUIRE_KEY=1`, so a missing secret fails the build. Builds without the key (local, forks) show the leaderboard read-only and cannot upload; withdrawing still works because deletion is signed by the install key alone.

The key ships inside every release binary, so treat it as a speed bump, not a secret. Per-install keys with proof of work, signed run evidence and after-the-fact peer validation do the real work.

Rotation: add the new key to `ARENA_APP_KEYS`, update the GitHub secret, ship a release, then remove the old key from `ARENA_APP_KEYS`.
