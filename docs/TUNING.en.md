# Local tuning guide

[简体中文](TUNING.md) · [User guide](USER_GUIDE.en.md) · [Verification](VERIFICATION.md)

Tuning compares a finite set of parameter candidates for the same model on this computer. The default **one-click speed-up** takes about 10 minutes without restarting the model; use **scenario verification** in the advanced area to compare restart parameters and full task quality. Reports validate the selected use case; keep the original configuration when no stable gain is found. Isolated HTTP, real background-process fixtures and browser contracts have been tested. Full tuning with a real GPU and the final installed application remains pending.

## One-click speed-up (default)

Open **Parameter tuning** and select **Speed up**; no use case has to be chosen first. The default "General" measurement covers short answers and long answers of 512+ tokens and only accepts a change that slows neither. It takes about 10 minutes, does not restart the model and does not edit the configuration file; the model is busy meanwhile.

1. **Health check**, run when the page opens without using the model:
   - **Free GPU memory**: when free VRAM after loading is below the safety floor (1 GiB on Windows, 512 MiB elsewhere, 2 GiB with the "Save GPU memory" goal), the fix reserves memory (`--vram-reserve-mib`) and switches a fixed expert cache to `--expert-cache auto`. A reserve suggested in the engine log wins when larger.
   - **Long context**: at 64K+ context with no resident window, outside WSL and with enough free RAM, `--kv-resident 32768` keeps KV beyond the resident window in RAM (about 13.7 KB per token).
   - **GPU/RAM split**: a fixed `--pcie-frac` is reported because it turns off the engine's own adjustment (information only).
   - A fix saves a new configuration version (`*-speedfix-DATE.json`) and switches to it; the original file is untouched.
2. **Baseline**: the current settings are measured first and always shown as "Before".
3. **Sweep**: quick calibration measures prefill pipe, the GPU/RAM split (PCIe) and the MTP threshold. When the engine can split automatically (CUDA ≥ 0.1.42 on one GPU or RDNA4 ≥ 0.1.43, no layer split, no `--batch`, no `--peer-device`), "leave it to the engine" is the reference: a fixed value is only written when clearly faster (over 3%), and a fixed `--pcie-frac` is removed when automatic is not slower (within 1%).
4. **Result**: before/after tok/s, short and long answers separately, and a plain-language line per change. When nothing is clearly faster the reason is explained and nothing is offered.
5. **Use these settings** saves a new version (`*-speedup-DATE.json`) and switches to it; **Roll back** switches back to the previous version. The original file is never modified.

**Advanced · expert mode** is collapsed by default and holds the optional use case (General / Chat / Coding and agents / Long writing), goal (Fastest / Balanced / Save GPU memory) and rounds per value; the detailed charts and log, save-as or overwrite, and scenario verification below. Historical short-request reports stay viewable there; new short diagnostics are no longer offered.

## Scenario verification (advanced)

### Getting started

1. Wait for a local model to become ready in the desktop application. Existing models can be imported; tuning does not download another copy.
2. Open **Parameter tuning**, expand **Advanced · expert mode** and choose **Everyday chat**, **Coding and Agent**, or **Long document analysis** in scenario verification.
3. Usually, keep the defaults and select **Start measurement**. The background waits for idle work before entering maintenance. Other API requests may wait or report busy during this period.
4. Review task quality, repeated gains, resource headroom and recovery status. Only a complete report that passes every condition can **Apply and verify**. Measurement restores the original configuration.
5. To undo an applied result, select **Restore original parameters**. Exported reports contain measurement metadata, without prompts, responses or tool bodies.

Avoid editing the same configuration in another program during tuning. When external changes are detected, they are preserved and a repair is requested; an old report does not overwrite the new configuration.

## What each use case measures

| Use case | Actual workloads | Quality conditions |
| --- | --- | --- |
| Everyday chat | English/Chinese multi-turn chat, cold input, hot prefix, session changes and sustained generation | Correct facts and follow-up transformations; complete structure without truncation |
| Coding and Agent | Read a fixed code fixture, propose a patch, run bounded deterministic checks and continue from tool results; separate session changes | Correct arguments and tool IDs; passing patch checks; complete final response |
| Long documents | Token-counted, multi-position retrieval, long-prefix reuse and session changes | Correct facts, relations and citations; inputs and answers fit the current capacity |

The coding workload uses immutable in-memory fixtures and a bounded interpreter. It does not execute arbitrary model-generated commands or modify user projects. Passing demonstrates this representative task, without establishing correctness for a whole project or every Agent.

Long-document inputs use 16K, 32K, 64K and other tiers that fit the current capacity with answer headroom. The test context limit does not change model Context, KV or RoPE. The default long-document test limit is 32K; the actual input tier still reserves space for answers. Choose longer tiers in advanced settings; insufficient capacity rejects the test.

**Also check image understanding** uses a fixed image fixture with already configured vision support. It does not download a vision model. Unselected or unconfigured vision cannot be marked as passed. Other unmeasured use cases also remain unverified.

## Parameters and recommendation conditions

Defaults compare nearby PCIe budget and MTP threshold values. Advanced settings add up to four independent restart candidates: CPU workers, asynchronous swapping, prefill chunks and GPU memory reservation. Tuning never reduces the existing reservation or automatically enables large resident-memory configurations.

Startup verification separates requests from observations. Workers and asynchronous swapping require effective telemetry. Prefill chunks may shrink dynamically: a verified startup ceiling does not prove every effective chunk. A reservation request does not establish measured free GPU memory. Unknown effective states are not treated as active.

Each candidate runs interleaved **original A → candidate B → original A**, with two rounds by default. Outputs must be complete and pass semantic checks. Gains must exceed measured baseline drift and repeat. Ordinary workloads compare the sum of generation-request times; Agent workloads include bounded tool processing. Total workload time additionally includes token-count calibration and other overhead; the report distinguishes the two measures.

Resources are sampled total machine RAM and primary-GPU memory use, including other programs. They do not establish exclusive model costs. Unknown or insufficient headroom prevents recommendation and application. Current conservative floors are 1 GiB RAM and 256 MiB primary-GPU memory. Sampled floors do not guarantee freedom from transient OOM or establish longer-context stability.

Short request diagnostics were removed from the interface; historical reports remain viewable in the advanced area. Old and diagnostic reports cannot apply new recommendations; original parameters from an already applied report can still be restored.

## Cancellation, failure and recovery

The interface shows actual phases, completed workload counts and elapsed time. Measurement has a two-hour hard deadline. Individual long-document workloads allow up to 20 minutes, and other workloads up to 10 minutes. These limits are not completion estimates or speedup promises.

After cancellation, load failure, timeout or OOM, a separate recovery operation restores the exact original configuration bytes and checks service health plus a short request. Recovery has an independent seven-minute deadline. Cancellation disconnects only this task's stream, without using global service cancellation.

If **Recovery failed** appears, inspect the error and the separate configuration-restored/service-verified states. Do not treat failure as successful recovery or immediately apply another report. The background retains recovery records. Resolve external configuration changes, unknown process ownership or insufficient resources before preparing the model again. It does not start a second large model to bypass conflicts.

Changes to the model, engine, hardware or configuration invalidate reports for new application. Driver version is currently unknown, model identity uses size and modification time, and resources are sampled. These limits and real-GPU/install-package acceptance status are recorded in [Verification](VERIFICATION.md).
