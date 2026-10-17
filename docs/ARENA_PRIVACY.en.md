# Benchmark leaderboard privacy

The Benchmark leaderboard is optional. Without joining, benchmarks run as usual and results stay on your computer.

## When results are uploaded

After you agree in Strata Manager under **Benchmark → Leaderboard**, each completed benchmark is uploaded once. The consent screen shows the exact content before anything is sent. Auto-upload can be turned off at any time; results still waiting to upload are discarded when you do.

## What is uploaded

| Category | Fields |
| --- | --- |
| Hardware | GPU vendor, model and VRAM; CPU model; total memory; PCIe generation and width; OS type and architecture; whether WSL is used |
| Model | Model family, quantization, a fingerprint computed from model file names and sizes, model size |
| Launch parameters | Context length, KV cache type, GPU count, parallel slots, threads, expert cache, PCIe fraction, vision on or off |
| Results | Prefill and decode speed, time to first token, peak VRAM and memory, and success for each context tier; scenario runs upload only summary speeds and request counts |
| Run evidence | Context runs only: for each request, start and end offsets from the start of the run, time to first token, prompt / cached / output token counts, prefill and decode speed, and the number of resource samples; time-compressed VRAM, memory and GPU utilization curves (at most 120 points); Strata counter readings (requests, prompt and output tokens) before and after the run; Strata version and run duration |
| Versions | Strata Manager and Strata versions, consent version |
| Install public key | A random Ed25519 public key created on your computer when you join (sent once, at registration) |

The app builds every upload from a fixed whitelist. Text fields may contain only letters, digits and a few punctuation marks, and both the app and the server validate the shape before accepting it.

## What is never uploaded

File paths, computer name, user name, API keys, service URLs, prompts, answers and logs are never uploaded. Run evidence contains numbers only: no text and no dates or times of day.

## Install key and IP addresses

When you join, the app creates a random Ed25519 key pair on your computer. The private key stays in the system credential store (or, where none is available, in an owner-only file in the app data folder) and is never uploaded. The public key is registered once before the first upload; registration takes about a second of computation on your machine (proof of work), which makes faking many machines expensive. Every upload and deletion is then signed with the private key, and the server identifies the install only by that public key.

The public key is not linked to your identity, computer name or accounts. It is used only to combine runs from the same machine into one median, to check whether results are trustworthy, and to let you delete your data. For each public key the server stores the registration time, the last upload time, the number of uploads and a trust score.

The server does not store IP addresses. For rate limiting it stores a truncated keyed hash of the IP address and the current day, and deletes it after two days.

## Run evidence and trust

A context benchmark run in the app carries run evidence, signed separately with the install's private key. The server checks that the evidence and the result agree: each tier equals the median of its requests; timestamps increase and do not overlap; time to first token matches the prefill speed and request time matches the decode speed; prompt tokens fit the tier; the number of resource samples fits the run duration; peak VRAM and memory in the curves match the result and do not exceed the machine's VRAM and memory; the Strata counters moved by at least the requests and tokens in the result; and the Strata version matches.

A result that passes every check counts on the leaderboard immediately, from the first upload, with no waiting period. Results without run evidence (such as scenario runs) or that fail a check are stored but not counted. Once other machines share the configuration, the server also cross-checks: results far from machines running the same model, quantization, hardware and parameters, or with a first-token time that contradicts the reported prefill speed, are flagged and left out; when most of a machine's results are flagged, none of them count. Maintainers can hide individual results or disable uploads from a public key.

## Retention and deletion

Results are kept for 12 months and then deleted automatically. **Withdraw and delete my data** immediately deletes every result this machine uploaded, removes this machine's public key registration, and clears the local private key and upload queue. Joining again creates a new key that is not linked to earlier data. For a disabled key, withdrawing keeps only a digest of the public key and the disabled mark, so it cannot register again. Results, and key registrations with no uploads, are deleted automatically after 12 months.

## How the leaderboard uses the data

The leaderboard compares only within the same model and quantization, grouped by hardware and launch parameters. Only results that passed the checks are used. Each machine counts as the median of its last 3 runs and outliers are removed. Configurations with fewer than 3 machines are labelled For reference or Few samples and are not used for parameter suggestions. Maintainer runs are labelled separately. The app and website show only aggregates, never individual machines.

Service: `https://arena.cosfoc.com`, running on Cloudflare Workers and D1.
