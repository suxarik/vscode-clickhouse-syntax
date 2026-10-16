-- %% markdown
-- # Where did the time go
--
-- A tour of the plan visualiser, against the `demo` database. Connect to
-- `localhost:18125`, database `demo`, no password.
--
-- Run a cell with the play button to see its rows. Use the **Analyze** action
-- on a cell to run it and draw the plan underneath instead — operator by
-- operator, with the time each one really cost.

-- %% markdown
-- ## 1. What is in here
--
-- Eight million events across four months of partitions, two million orders,
-- three hundred thousand users, and a `ReplacingMergeTree` of stock levels.

-- %% the shape of the data
SELECT
    table,
    formatReadableQuantity(sum(rows)) AS rows,
    formatReadableSize(sum(bytes_on_disk)) AS on_disk,
    count() AS parts
FROM system.parts
WHERE database = 'demo' AND active
GROUP BY table
ORDER BY table;

-- %% markdown
-- ## 2. A plain aggregation
--
-- Analyze this one first. Almost all the time is in `ReadFromMergeTree`, so
-- the flame is one wide bar with hairlines above it. That is what a healthy
-- scan-bound query looks like: the work is in reading, and nothing else is
-- worth tuning.

-- %% a month of purchases
SELECT count() AS purchases, round(sum(revenue), 2) AS revenue
FROM demo.events
WHERE event_date >= today() - 30 AND event_type = 'purchase';

-- %% markdown
-- ## 3. Where aggregation starts to cost
--
-- `uniqExact` keeps every distinct value in memory, so the Aggregating step
-- takes a visible slice of the bar. Compare it with `uniq` below — the plan
-- shape is identical and the cost is not.

-- %% exact distinct, the expensive way
SELECT device, country, uniqExact(user_id) AS people
FROM demo.events
WHERE event_date >= today() - 30
GROUP BY device, country
ORDER BY people DESC;

-- %% approximate distinct, the cheap way
SELECT device, country, uniq(user_id) AS people
FROM demo.events
WHERE event_date >= today() - 30
GROUP BY device, country
ORDER BY people DESC;

-- %% markdown
-- ## 4. A join, where the plan stops being a line
--
-- Two tables are read at the same time and meet in the middle. Switch to the
-- **Graph** view for this one: the flame flattens a fork into a staircase,
-- and the node-link view shows both branches and which of them cost more.

-- %% orders joined to the people who placed them
SELECT u.plan, count() AS orders, round(avg(o.amount), 2) AS avg_amount
FROM demo.orders AS o
INNER JOIN demo.users AS u ON u.user_id = o.user_id
WHERE o.status = 'paid'
GROUP BY u.plan
ORDER BY orders DESC;

-- %% markdown
-- ## 5. The hard one
--
-- Three tables, two joins, an array unrolled, and a filter on each side. The
-- widest plan in this runbook — twenty-six steps, folded down to something a
-- person can actually read.

-- %% what sold, joined to what is left in stock
SELECT
    item_sku,
    count() AS times_ordered,
    round(sum(o.amount), 2) AS revenue,
    any(i.stock) AS stock
FROM demo.orders AS o
ARRAY JOIN o.items AS item_sku
INNER JOIN demo.users AS u ON u.user_id = o.user_id
INNER JOIN demo.inventory AS i ON i.sku = item_sku
WHERE o.status IN ('paid', 'shipped') AND u.plan != 'free'
GROUP BY item_sku
ORDER BY revenue DESC
LIMIT 50;

-- %% markdown
-- ## 6. Two branches that merge
--
-- `UNION ALL` is the clearest fan-in the graph will draw: two independent
-- subtrees that join at the top. In the flame they sit side by side, each as
-- wide as it cost.

-- %% events and orders per month, side by side
SELECT 'events' AS source, toStartOfMonth(event_date) AS month, count() AS n
FROM demo.events
WHERE event_date >= today() - 120
GROUP BY month
UNION ALL
SELECT 'orders' AS source, toStartOfMonth(toDate(created_at)) AS month, count() AS n
FROM demo.orders
WHERE created_at >= now() - INTERVAL 120 DAY
GROUP BY month
ORDER BY month, source;

-- %% markdown
-- ## 7. Reading back what really happened
--
-- The panel reads this table for you, but it is worth seeing once. Note that
-- the summed CPU time is larger than the wall clock: the query ran on several
-- threads, and the two numbers are not the same thing.

-- %% the last few queries, by cost
SELECT
    query_duration_ms,
    formatReadableQuantity(read_rows) AS rows_read,
    formatReadableSize(memory_usage) AS memory,
    length(thread_ids) AS threads,
    substring(replaceRegexpAll(query, '\\s+', ' '), 1, 60) AS query
FROM system.query_log
WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 30 MINUTE AND query NOT LIKE '%system.query_log%'
ORDER BY query_duration_ms DESC
LIMIT 10;
