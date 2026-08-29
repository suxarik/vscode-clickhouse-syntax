## Understand a query before it runs

**ClickHouse: Explain Query** shows the plan, the pipeline, and estimated rows
per step, rendered as a tree rather than raw text.

Names are resolved against the server through `EXPLAIN QUERY TREE`, so a column
that does not exist is caught without reading a single row.

**ClickHouse: Profile Last Query** reads the real counters from
`system.query_log` after the fact — rows read, bytes read, peak memory, threads.

The 17 lint rules catch what a plan will not: a missing `PREWHERE`, a
`SELECT *`, a `JOIN` without a condition. **ClickHouse: Show Lint Rules** lists
them all, and each is individually configurable.
