-- %% markdown
-- # What is my query doing
--
-- Paste the query into the cell below and work down. The plan says what
-- ClickHouse intends to do; `system.query_log` says what it actually did.

-- %% markdown
-- ## What the planner intends
--
-- `indexes = 1` is the important part: it reports how many parts and granules
-- survived each index. If nothing was pruned, the index is not being used.

-- %% the plan
EXPLAIN indexes = 1
SELECT count()
FROM system.numbers
WHERE number < 1000;

-- %% markdown
-- ## What it costs to run
--
-- Run the query itself, then the cell after it reads back what it really did.

-- %% the query
SELECT count()
FROM system.numbers
WHERE number < 1000;

-- %% markdown
-- ## What it actually did
--
-- `read_rows` far above `result_rows` means the work is in the scan, not the
-- aggregation. Compare `memory_usage` against your `max_memory_usage`.

-- %% what it actually cost
SELECT
    round(query_duration_ms) AS ms,
    formatReadableQuantity(read_rows) AS rows_read,
    formatReadableSize(read_bytes) AS bytes_read,
    result_rows,
    formatReadableSize(memory_usage) AS peak_memory,
    length(thread_ids) AS threads
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_id = (
      SELECT query_id
      FROM system.query_log
      WHERE type = 'QueryFinish' AND query LIKE '%system.numbers%'
      ORDER BY event_time DESC
      LIMIT 1
  )
ORDER BY event_time DESC
LIMIT 1;

-- %% markdown
-- ## Where the time went
--
-- The profile events for that run: bytes read from disk versus from the page
-- cache, time waiting on locks, rows filtered by each stage.

-- %% profile events
SELECT
    event,
    value
FROM system.query_log
ARRAY JOIN ProfileEvents.keys AS event, ProfileEvents.values AS value
WHERE type = 'QueryFinish'
  AND event_time > now() - toIntervalMinute(10)
  AND value > 0
  AND event LIKE '%Read%'
ORDER BY event_time DESC, value DESC
LIMIT 25;
