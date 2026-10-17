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
| Versions | Strata Manager and Strata versions, consent version, anonymous install ID |

The app builds every upload from a fixed whitelist. Text fields may contain only letters, digits and a few punctuation marks, and both the app and the server validate the shape before accepting it.

## What is never uploaded

File paths, computer name, user name, API keys, service URLs, prompts, answers and logs are never uploaded.

## Anonymous install ID and IP addresses

The install ID is a random 64-digit hexadecimal number created on your computer. It is used only to combine runs from the same machine into one median and to let you delete your data. The server stores only a one-way hash of it.

The server does not store IP addresses. For rate limiting it stores a truncated keyed hash of the IP address and the current day, and deletes it after two days.

## Retention and deletion

Results are kept for 12 months and then deleted automatically. **Withdraw and delete my data** immediately deletes every result this machine uploaded, and clears the local install ID and upload queue. Joining again creates a new install ID that is not linked to earlier data.

## How the leaderboard uses the data

The leaderboard compares only within the same model and quantization, grouped by hardware and launch parameters. Each machine counts as the median of its last 3 runs, outliers are removed, and a configuration needs at least 3 machines to be ranked. Maintainer runs are labelled separately. The app and website show only aggregates, never individual machines.

Service: `https://arena.cosfoc.com`, running on Cloudflare Workers and D1.
