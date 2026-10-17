# Benchmark Arena service

Cloudflare Worker + D1 behind `https://arena.cosfoc.com`. It accepts opt-in benchmark summaries from Strata Manager and serves the leaderboard used by the app and the website.

## API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/health` | – | Schema and consent version. |
| POST | `/v1/register/challenge` | – | Proof-of-work challenge `{ challenge, bits, expiresAt }`, valid 10 minutes, single use. |
| POST | `/v1/register` | app key + install key | Body `{ publicKey, challenge, counter, consentVersion }`. Registers an Ed25519 public key. |
| POST | `/v1/submit` | app key + install key | Body must match the whitelist in `src/schema.js`; unknown keys are rejected. |
| DELETE | `/v1/me` | install key | Body `{}`. Deletes every submission of the key and the key registration. |
| GET | `/v1/groups` | – | Model + quant groups with totals (`machines` counts trusted installs, `pendingMachines` installs in probation). |
| GET | `/v1/leaderboard?group=&gpu=&vram=` | – | Rows for one group (hardware + launch parameters). |
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

### Proof of work

The challenge is `ts.rand.bits.mac`, where `mac` is an HMAC with `POW_SECRET`, so the difficulty cannot be lowered by the client. The client finds `counter` such that

```
sha256("strata-arena-pow|" + challenge + "|" + publicKeyHex + "|" + counter)
```

has at least `bits` leading zero bits. The public key is part of the preimage, so a solution cannot be reused for another key. Difficulty is `POW_BITS` (default 25; one thread on a CPU with SHA extensions averages about 2 s, older CPUs several times longer) and rises by 2 while more than `POW_SURGE` (default 30) installs registered in the last hour. Registrations are also limited to 10 per IP per day.

## Reputation (`src/trust.js`)

The hourly cron (and every maintainer action) recomputes each install:

- **Probation**: a new key's runs are stored but excluded from all public aggregates.
- **Trusted** when it has at least 3 submissions over at least 2 server days (UTC), at most a third of its runs are flagged, and its results agree with peers: for each configuration (model + quant + GPU + VRAM/RAM tier + launch parameters) its machine median lies within `max(3.5 × 1.4826 × MAD, 12 % of median)` of the other machines' median (needs 2 or more peers; 75 % of compared configurations must agree). With only one peer, a peer within 20 % corroborates.
- **Flagged** when more than a third of its runs are flagged, or it disagrees on most configurations.
- **Per-run flags**: `peer_outlier` (more than 1.8× above or below the peers' median) and `ttft_fast` (first token faster than the reported prefill speed allows). Flagged runs never enter aggregates.
- **Trust score** 0–1 combines history, consistency and the flag rate; it is visible to maintainers only.

Maintainer seed rows (valid `X-Arena-Seed` header) are always trusted, labeled in the UI, may appear below the 3-machine threshold, and are excluded from public totals.

## Maintainer endpoints

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://arena.cosfoc.com/v1/admin/installs?status=probation
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://arena.cosfoc.com/v1/admin/installs/<keyId>     # details + last 200 runs
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

```sh
wrangler d1 create strata-arena                 # once; put the id in wrangler.toml
npm run migrate                                 # applies migrations/ in order to the remote DB
wrangler secret put ARENA_APP_KEYS              # comma-separated; list old and new key during a rotation
wrangler secret put IP_SALT
wrangler secret put SEED_TOKEN
wrangler secret put POW_SECRET
wrangler secret put ADMIN_TOKEN
npm run deploy                                  # POW_BITS / POW_SURGE are plain vars in wrangler.toml
```

### App key

The source tree contains no app key. CI compiles it in from the repository secret `ARENA_APP_KEY` (`STRATA_ARENA_APP_KEY` at build time, `.github/workflows/ci.yml` → *Build test installers*); release-capable runs in this repository set `STRATA_ARENA_REQUIRE_KEY=1`, so a missing secret fails the build. Builds without the key (local, forks) show the leaderboard read-only and cannot upload; withdrawing still works because deletion is signed by the install key alone.

The key ships inside every release binary, so treat it as a speed bump, not a secret. Per-install keys with proof of work, probation and peer validation do the real work.

Rotation: add the new key to `ARENA_APP_KEYS`, update the GitHub secret, ship a release, then remove the old key from `ARENA_APP_KEYS`.
