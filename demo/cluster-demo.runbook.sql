-- %% markdown
-- # Is this cluster healthy, and is the data where it should be
--
-- Four nodes: two shards, two replicas each, with Keeper behind them. Connect
-- to any one of them — `localhost:18131` through `18134`, user `default`, no
-- password — and everything below reaches the rest through it.
--
-- Nothing here writes. A cluster gets looked at during an incident, which is
-- exactly when a runbook should not be able to make things worse.
--
-- **ClickHouse: Show Cluster** draws all of this. The queries are here so you
-- can see where the picture comes from.

-- %% markdown
-- ## 1. What is configured
--
-- `system.clusters` is the topology as the config declares it, not as it is
-- right now: a node that is switched off still has a row here, and
-- `errors_count` stays at zero until this node has tried to reach it and
-- failed. Configuration, not health.

-- %% the shape of the cluster
SELECT
    shard_num,
    replica_num,
    host_name,
    port,
    is_local,
    errors_count
FROM system.clusters
WHERE cluster = 'analytics'
ORDER BY shard_num, replica_num;

-- %% markdown
-- ## 2. Where the rows actually are
--
-- The sharding key decides which shard a row lands on. Nothing checks that it
-- divides them evenly, so this is worth looking at directly.
--
-- `_shard_num` is a virtual column on a `Distributed` table: it says which
-- shard each row came back from.

-- %% rows per shard, by sharding key
SELECT 'events  (sharded by user_id)' AS sharded_by, _shard_num AS shard, count() AS rows
FROM demo.events
GROUP BY shard
UNION ALL
SELECT 'skewed  (sharded by status)' AS sharded_by, _shard_num AS shard, count() AS rows
FROM demo.skewed
GROUP BY shard
ORDER BY sharded_by, shard;

-- %% markdown
-- `user_id` has a hundred thousand distinct values, so it divides: roughly
-- half the rows on each shard.
--
-- `status` has three. Three values cannot spread across two shards, so two of
-- them land together and one shard carries twice the other. The cluster is
-- then only as fast as its busiest node, and adding a third shard would not
-- help — there would still be only three values to divide.

-- %% markdown
-- ## 3. The same thing, per replica
--
-- Replicas of one shard hold the same rows. If two disagree, one is behind or
-- has lost parts — and that is invisible from either of them alone.

-- %% what each node is holding
SELECT
    getMacro('shard') AS shard,
    getMacro('replica') AS node,
    table,
    sum(rows) AS rows,
    formatReadableSize(sum(bytes_on_disk)) AS on_disk,
    count() AS parts
FROM clusterAllReplicas(analytics, system.parts)
WHERE database = 'demo' AND active
GROUP BY shard, node, table
ORDER BY table, shard, node
SETTINGS skip_unavailable_shards = 1;

-- %% markdown
-- ## 4. Is replication keeping up
--
-- `absolute_delay` is how far behind a replica is, in seconds. `queue_size` is
-- what it still has to apply. `active_replicas` against `total_replicas` is
-- how much redundancy is actually there, as opposed to configured.

-- %% replication health across the cluster
SELECT
    getMacro('replica') AS node,
    table,
    is_readonly,
    is_session_expired,
    absolute_delay,
    queue_size,
    active_replicas,
    total_replicas,
    lost_part_count
FROM clusterAllReplicas(analytics, system.replicas)
ORDER BY node, table
SETTINGS skip_unavailable_shards = 1;

-- %% markdown
-- ## 5. What a distributed query asks of each shard
--
-- Run the query below, then the cell after it reads back what each shard was
-- asked to do. They share one `initial_query_id`, but each shard logs its own
-- subquery in its own `system.query_log`, so reading them means going back out
-- across the cluster.
--
-- The initiator's row counts the **whole** query rather than its own shard, so
-- its local share is what is left after the others are taken off.

-- %% a distributed query to measure
SELECT status, count() AS n, round(avg(revenue), 2) AS avg_revenue
FROM demo.events
WHERE event_date >= today() - 30
GROUP BY status
ORDER BY n DESC;

-- %% what each shard did for the last distributed query
SELECT
    getMacro('shard') AS shard,
    getMacro('replica') AS node,
    query_id = initial_query_id AS is_initiator,
    query_duration_ms,
    read_rows,
    formatReadableSize(read_bytes) AS read,
    formatReadableSize(memory_usage) AS memory
FROM clusterAllReplicas(analytics, system.query_log)
WHERE type = 'QueryFinish'
  AND initial_query_id = (
      SELECT query_id
      FROM system.query_log
      WHERE type = 'QueryFinish' AND query LIKE '%avg_revenue%' AND query NOT LIKE '%query_log%'
      ORDER BY event_time DESC
      LIMIT 1
  )
ORDER BY is_initiator DESC, shard
SETTINGS skip_unavailable_shards = 1;

-- %% markdown
-- If that cell comes back short — one row, or none — the log entries have not
-- been written yet. The `*_log` tables flush on a timer, and each node flushes
-- its own. A profile allowed to write can force every node at once with
-- `SYSTEM FLUSH LOGS ON CLUSTER analytics`; otherwise wait a few seconds and
-- run it again.
--
-- The node that answers for a shard may differ between runs. A shard has two
-- replicas and either can serve the read, so the same query can be logged on
-- `ch-03` once and `ch-04` the next time. That is the point of having two.

-- %% markdown
-- ## 6. One shard, from the inside
--
-- `demo.events` is the `Distributed` table and fans out. `demo.events_local`
-- is the real table on whichever node you are connected to. Comparing them
-- shows what one shard holds against the whole.

-- %% the local table against the distributed one
SELECT 'this node only' AS scope, count() AS rows FROM demo.events_local
UNION ALL
SELECT 'every shard' AS scope, count() AS rows FROM demo.events
ORDER BY rows;

-- %% markdown
-- ## 7. What a missing replica looks like
--
-- Stop one and look again:
--
-- ```
-- docker stop ch-04
-- ```
--
-- The cell below asks every configured host whether it answered.
-- `system.clusters` will still list it, and its `errors_count` will still be
-- zero — absence from the fan-out is the only thing that actually shows it.
--
-- Start it again with `docker start ch-04`.

-- %% which configured hosts are answering
SELECT
    host_name,
    shard_num,
    replica_num,
    if(host_name IN (
        SELECT getMacro('replica')
        FROM clusterAllReplicas(analytics, system.one)
        SETTINGS skip_unavailable_shards = 1
    ), 'answering', 'DID NOT ANSWER') AS state
FROM system.clusters
WHERE cluster = 'analytics'
ORDER BY shard_num, replica_num;
