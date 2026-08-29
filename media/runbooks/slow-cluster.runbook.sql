-- %% markdown
-- # Why is this cluster slow
--
-- Work down the list. Each cell narrows the question the one before it opened,
-- so read the output before running the next.
--
-- Nothing here writes anything, so it is safe on a read-only profile.

-- %% markdown
-- ## What is running right now
--
-- If something has been running for minutes, stop here — that is the answer.
-- The `query_id` is what you pass to `KILL QUERY`.

-- %% currently running
SELECT
    query_id,
    round(elapsed, 1) AS seconds,
    formatReadableQuantity(read_rows) AS rows_read,
    formatReadableSize(memory_usage) AS memory,
    user,
    substring(query, 1, 80) AS query
FROM system.processes
WHERE query NOT LIKE '%system.processes%'
ORDER BY elapsed DESC
LIMIT 20;

-- %% markdown
-- ## What has been slow lately
--
-- Over the last `{hours:UInt32}` hours, grouped by the shape of the query
-- rather than its literals — so a hundred runs of the same query appear once.

-- %% slowest query shapes
SELECT
    normalized_query_hash AS shape,
    count() AS runs,
    round(avg(query_duration_ms)) AS avg_ms,
    round(quantile(0.95)(query_duration_ms)) AS p95_ms,
    formatReadableQuantity(sum(read_rows)) AS rows_read,
    formatReadableSize(max(memory_usage)) AS peak_memory,
    any(substring(query, 1, 100)) AS example
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - toIntervalHour({hours:UInt32})
GROUP BY shape
ORDER BY avg_ms * runs DESC
LIMIT 20;

-- %% markdown
-- ## Is it reading more than it should
--
-- A query reading far more rows than it returns is usually a missing
-- `PREWHERE`, a primary key the `WHERE` cannot use, or no partition pruning.

-- %% worst read amplification
SELECT
    substring(query, 1, 90) AS query,
    formatReadableQuantity(read_rows) AS rows_read,
    result_rows,
    intDiv(read_rows, greatest(result_rows, 1)) AS amplification,
    round(query_duration_ms) AS ms
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - toIntervalHour({hours:UInt32})
  AND read_rows > 1000000
ORDER BY amplification DESC
LIMIT 20;

-- %% markdown
-- ## Did anything fail
--
-- Failures cost the same work as successes and are easy to miss.

-- %% recent failures
SELECT
    event_time,
    substring(query, 1, 80) AS query,
    exception_code,
    substring(exception, 1, 100) AS exception
FROM system.query_log
WHERE type != 'QueryFinish'
  AND exception != ''
  AND event_time > now() - toIntervalHour({hours:UInt32})
ORDER BY event_time DESC
LIMIT 20;
