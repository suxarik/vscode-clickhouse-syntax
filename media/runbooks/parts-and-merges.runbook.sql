-- %% markdown
-- # Which parts are not merging
--
-- Too many parts is the most common cause of a MergeTree table getting slowly,
-- steadily worse: every query touches every part. This works out whether that
-- is happening and why.

-- %% markdown
-- ## Which tables have the most parts
--
-- A few dozen active parts per partition is normal. Hundreds is not.

-- %% parts per table
SELECT
    database,
    table,
    count() AS parts,
    uniqExact(partition) AS partitions,
    round(count() / greatest(uniqExact(partition), 1)) AS parts_per_partition,
    formatReadableSize(sum(bytes_on_disk)) AS on_disk,
    formatReadableQuantity(sum(rows)) AS rows
FROM system.parts
WHERE active AND database NOT IN ('system', 'INFORMATION_SCHEMA')
GROUP BY database, table
ORDER BY parts DESC
LIMIT 20;

-- %% markdown
-- ## Are merges running, or stuck
--
-- An empty result here with a high part count above means merges are not
-- keeping up — check `max_bytes_to_merge_at_max_space_in_pool` and the disk.

-- %% merges in flight
SELECT
    database,
    table,
    round(elapsed, 1) AS seconds,
    round(progress * 100) AS pct,
    num_parts,
    formatReadableSize(total_size_bytes_compressed) AS size,
    formatReadableSize(memory_usage) AS memory
FROM system.merges
ORDER BY elapsed DESC;

-- %% markdown
-- ## Is anything failing to replicate
--
-- A growing queue with a `last_exception` is the thing to fix first.

-- %% replication queue
SELECT
    database,
    table,
    type,
    count() AS entries,
    max(num_tries) AS max_tries,
    any(substring(last_exception, 1, 120)) AS last_exception
FROM system.replication_queue
GROUP BY database, table, type
ORDER BY entries DESC
LIMIT 20;

-- %% markdown
-- ## Which columns are actually costing the disk
--
-- For one table: `{db:String}`.`{tbl:String}`. Compression ratios below about
-- two usually mean the wrong codec or a column that should be `LowCardinality`.

-- %% column sizes
SELECT
    column,
    formatReadableSize(sum(column_bytes_on_disk)) AS on_disk,
    formatReadableSize(sum(column_data_uncompressed_bytes)) AS uncompressed,
    round(sum(column_data_uncompressed_bytes) / greatest(sum(column_bytes_on_disk), 1), 1) AS ratio
FROM system.parts_columns
WHERE active AND database = {db:String} AND table = {tbl:String}
GROUP BY column
ORDER BY sum(column_bytes_on_disk) DESC;
