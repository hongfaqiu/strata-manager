-- Benchmark Arena schema v4: official-method runs (kind = 'official', Strata tools/strata_bench.py as run in the app).
-- Additive only: new nullable columns. Existing rows, columns and tables are untouched;
-- the per-run summary also stays in result_json ({ "official": { upstream, runs, long, metrics } }).
ALTER TABLE submissions ADD COLUMN off_chat_decode REAL;   -- chat decode tok/s (median of the 9 chat requests)
ALTER TABLE submissions ADD COLUMN off_chat_ttft_s REAL;   -- chat first token, s
ALTER TABLE submissions ADD COLUMN off_prefill_4k REAL;    -- prompt-processing tok/s at ~4K
ALTER TABLE submissions ADD COLUMN off_prefill_16k REAL;   -- ... at ~16K
ALTER TABLE submissions ADD COLUMN off_prefill_32k REAL;   -- ... at ~32K (--long)
ALTER TABLE submissions ADD COLUMN off_agent_decode REAL;  -- agent follow-up turns decode tok/s
ALTER TABLE submissions ADD COLUMN off_agent_hit REAL;     -- agent prompt-cache hit, %
ALTER TABLE submissions ADD COLUMN off_upstream TEXT;      -- commit of the script the run follows
