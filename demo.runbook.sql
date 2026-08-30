-- %% markdown
-- # Notebook demo
--
-- Against the local test server: `analytics.events` (500k rows),
-- `analytics.users` (5k), `staging.scratch` (1k).
--
-- **Pick the kernel first.** Top right → **Select Kernel** → `local`. It should
-- read `127.0.0.1 · read-only` — the kernel picker is the connection picker,
-- and it says what the profile is allowed to do, not just where it points.
--
-- Then run the cells top to bottom. Each one below says what to look at.

-- %% markdown
-- ## 1. A plain result
--
-- Nothing exotic — this is the grid you already know, rendered inside the
-- notebook by the same code the result panel uses. Sort a column, type in the
-- filter box, copy as CSV.

-- %% first look
SELECT
    event_date,
    event_type,
    user_id,
    revenue
FROM analytics.events
ORDER BY event_date, event_id
LIMIT 200;

-- %% markdown
-- ## 2. Sixty-four bit integers stay exact
--
-- `event_id` here is `18446744073709551615` — the largest `UInt64` there is,
-- and far past the 2^53 where `JSON.parse` starts rounding. Check the digits:
-- if they end in `615` it survived the wire. A naive client shows
-- `18446744073709552000`.

-- %% big integers
SELECT
    event_id,
    toString(event_id) AS as_text,
    user_id
FROM analytics.events
ORDER BY event_id DESC
LIMIT 5;

-- %% markdown
-- ## 3. Nested types
--
-- `tags` is an `Array`, `props` a `Map`, `geo` a `Tuple`, `note` a
-- `Nullable`. Click any of those cells and it opens in full rather than being
-- silently truncated. Nulls render distinctly from empty strings.

-- %% nested values
SELECT
    event_id,
    tags,
    props,
    geo,
    note
FROM analytics.events
WHERE length(tags) > 1
ORDER BY note IS NULL DESC, event_id
LIMIT 50;

-- %% markdown
-- ## 4. A chart, from a time series
--
-- Two columns, one of them a date, so the **Chart** button appears in the
-- toolbar and draws a line — the order means something. Toggle back with
-- **Rows**.
--
-- Try filtering the rows first, then charting: the chart follows the filter
-- and the sort, so what is drawn is what the rows above it would have shown.

-- %% events per day
SELECT
    event_date,
    count() AS events
FROM analytics.events
GROUP BY event_date
ORDER BY event_date;

-- %% markdown
-- ## 5. A chart, from labels
--
-- A label and a number gives bars instead. Hover a bar for its exact value.

-- %% revenue by type
SELECT
    event_type,
    round(sum(revenue), 2) AS revenue
FROM analytics.events
GROUP BY event_type
ORDER BY revenue DESC;

-- %% markdown
-- ## 6. A parameter
--
-- `{days:UInt32}` is a placeholder. You are asked for it **once** per
-- notebook, and the value goes to ClickHouse as its own query parameter — the
-- server substitutes it, with the declared type. Nothing is spliced into the
-- SQL, so a value typed into the box cannot be an injection.
--
-- Try `30`. Then run it again: it does not ask twice. **ClickHouse: Reset
-- Runbook Parameters** makes it ask again.

-- %% the last N days of data
SELECT
    event_date,
    count() AS events,
    round(sum(revenue), 2) AS revenue
FROM analytics.events
WHERE event_date > (SELECT max(event_date) FROM analytics.events) - {days:UInt32}
GROUP BY event_date
ORDER BY event_date;

-- %% markdown
-- ## 7. A join, to show the schema is understood
--
-- Delete a character out of `u.name` and it is underlined as you type — the
-- columns come from the live server, not from a guess. Completion works inside
-- the notebook exactly as it does in a `.sql` file.
--
-- Note the `FINAL`. `analytics.users` is a `ReplacingMergeTree`, so without it
-- you would count superseded rows — the lint rule says so if you delete it.

-- %% joined
SELECT
    u.name,
    count() AS events,
    round(sum(e.revenue), 2) AS revenue
FROM analytics.events AS e
INNER JOIN analytics.users AS u FINAL ON u.user_id = e.user_id
GROUP BY u.name
ORDER BY revenue DESC
LIMIT 25;

-- %% markdown
-- ## 8. The read-only rule holds here too
--
-- This cell is a write, and the `local` profile has no `allowWrite`. Running it
-- is **refused outright** — not a dialog you can click through — because a
-- notebook cell goes through exactly the same gate as the editor. It is the
-- same code, so a notebook cannot become a way around the rule.
--
-- Nothing is sent to the server. Check afterwards with cell 9.

-- %% this should be refused
INSERT INTO staging.scratch (id, payload) VALUES (999999, 'should never arrive');

-- %% markdown
-- ## 9. Confirming nothing happened
--
-- Zero. The row from cell 8 never left the client.

-- %% did it get through
SELECT count() AS rows_that_should_not_exist
FROM staging.scratch
WHERE id = 999999;

-- %% markdown
-- ## 10. What the file actually contains
--
-- Save this notebook, then open it in the text editor (right click the tab →
-- **Reopen Editor With** → **Text Editor**). You will find exactly what you see
-- here: comments and SQL, **and none of the rows above**.
--
-- The format has nowhere to put an output. That is what keeps a query result
-- from ending up in a commit.
--
-- The whole file is also a valid script:
--
-- ```
-- docker exec -i ch-local clickhouse-client --multiquery < demo.runbook.sql
-- ```
--
-- (that one needs `days` bound: add `--param_days=30`.)
