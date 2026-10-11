# Local tuning guide

[简体中文](TUNING.md) · [User guide](USER_GUIDE.en.md) · [Verification](VERIFICATION.md)

Tuning compares a finite set of parameter candidates for the same model on this computer. Reports validate the selected use case; keep the original configuration when no stable gain is found. Isolated HTTP, real background-process fixtures and browser contracts have been tested. Full tuning with a real GPU and the final installed application remains pending.

## Getting started

1. Wait for a local model to become ready in the desktop application. Existing models can be imported; tuning does not download another copy.
2. Open **Parameter tuning** and choose **Everyday chat**, **Coding and Agent**, or **Long document analysis**.
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

**Run short request diagnostics only** keeps historical probes for observation. Old and diagnostic reports cannot apply new recommendations; original parameters from an already applied report can still be restored.

## Cancellation, failure and recovery

The interface shows actual phases, completed workload counts and elapsed time. Measurement has a two-hour hard deadline. Individual long-document workloads allow up to 20 minutes, and other workloads up to 10 minutes. These limits are not completion estimates or speedup promises.

After cancellation, load failure, timeout or OOM, a separate recovery operation restores the exact original configuration bytes and checks service health plus a short request. Recovery has an independent seven-minute deadline. Cancellation disconnects only this task's stream, without using global service cancellation.

If **Recovery failed** appears, inspect the error and the separate configuration-restored/service-verified states. Do not treat failure as successful recovery or immediately apply another report. The background retains recovery records. Resolve external configuration changes, unknown process ownership or insufficient resources before preparing the model again. It does not start a second large model to bypass conflicts.

Changes to the model, engine, hardware or configuration invalidate reports for new application. Driver version is currently unknown, model identity uses size and modification time, and resources are sampled. These limits and real-GPU/install-package acceptance status are recorded in [Verification](VERIFICATION.md).
