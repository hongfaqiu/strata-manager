# Apple / macOS GPU probe fixtures

Inputs for `crates/runtime-core/src/apple_gpu.rs` tests. They follow the exact shape macOS prints;
volatile fields (serials, display EDIDs) are trimmed.

| File | Command | Machine |
| --- | --- | --- |
| `sp-displays-m5-pro.json` | `system_profiler SPDisplaysDataType -json` | Apple M5 Pro (shape from M-series Macs; the 20-core count is the fixture value used by the screenshots, not a spec claim) |
| `sp-displays-m1-max-external.json` | same | Apple M1 Max with an external display attached (two `spdisplays_ndrvs`) |
| `sp-displays-intel-amd.json` | same | Intel MacBook Pro 16" 2019: Intel UHD 630 + AMD Radeon Pro 5500M (legacy vendor spellings) |
| `sp-displays-vm.json` | same | macOS VM / CI runner: `Apple Paravirtual device`, no cores, no Metal family |
| `ioreg-agx-m5-pro.txt` | `ioreg -l -w0 -r -c IOAccelerator` | Apple M5 Pro AGX node, with `gpu-core-count` and `PerformanceStatistics` |
| `ioreg-agx-legacy.txt` | same | Older AGX node with only renderer/tiler utilization, no core count |
