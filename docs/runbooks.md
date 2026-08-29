# Runbooks

A runbook is prose, a query, its output, then the next step. That is how
incident and capacity work against `system.query_log`, `system.parts` and
`system.merges` actually goes, and it is the one thing a SQL editor cannot do.

**ClickHouse: Open a Runbook Template** starts you with one that already knows
the system tables.

## The file is just SQL

A runbook is a plain `.sql` file with `-- %%` cell markers:

```sql
-- %% markdown
-- # Why is this cluster slow
--
-- Start with what the server is doing right now.

-- %% currently running
SELECT query_id, elapsed, read_rows
FROM system.processes
ORDER BY elapsed DESC
LIMIT 10;
```

There is no JSON container. The consequences are the point:

- `clickhouse-client --multiquery < incident.runbook.sql` runs the whole thing.
- A diff shows the queries that changed, not a blob.
- Any existing `.sql` file is already a runbook — **ClickHouse: Open as Runbook**,
  or *Open With*.

`*.runbook.sql` and `*.chnb.sql` open as notebooks by default. Nothing else is
taken over: an ordinary `.sql` file still opens in the text editor.

### The markers

| Marker | Cell |
|---|---|
| `-- %%` | SQL |
| `-- %% a title` | SQL, with a label for the reader |
| `-- %% markdown`, `-- %% md` | Prose, one `-- ` per line |

Text before the first marker is a SQL cell, which is why a plain script opens as
a one-cell runbook without being rewritten.

**Cells followed by more SQL are terminated with `;` on save.** Without that,
`clickhouse-client` reads `LIMIT 10`, the comment after it, and the next `SELECT`
as one malformed statement. The last cell is left alone, so a plain script opened
and saved comes back byte for byte as it was.

## Outputs are never written to the file

The format has nowhere to put one. This is a property, not a promise: a file that
persists query results is a way for production rows to end up in a commit, and
`git add` does not ask what is inside.

Results live as long as the editor is open. To keep some, copy or export them
deliberately.

## One kernel per connection

The kernel picker **is** the connection picker. Each kernel is a profile, and
each says what it is allowed to do:

```
local    localhost · read-only
staging  ch.staging · writes permitted
prod     ch.internal · writes permitted, protected
```

There is no per-cell connection, on purpose. A single file quietly spanning
environments is exactly what the safety model exists to prevent.

A cell goes through the same gate as the editor, because it is the same code: a
read-only profile refuses a write here too, destructive statements confirm by
name, and interrupting sends `KILL QUERY`. Cells run in order and **stop at the
first failure** — cell three usually only makes sense if cell two said what you
expected.

## Parameters

`{name:Type}` placeholders make a runbook re-runnable over a different window,
cluster or customer:

```sql
-- %% markdown
-- Over the last {hours:UInt32} hours.

-- %% slowest queries
SELECT normalized_query_hash, avg(query_duration_ms)
FROM system.query_log
WHERE event_time > now() - toIntervalHour({hours:UInt32})
GROUP BY 1;
```

You are asked once per notebook, and the value is sent as ClickHouse's own
`param_<name>` — the **server** substitutes it, with the declared type. Nothing
is spliced into the SQL, so a value typed into a box cannot be an injection. An
unbound parameter is a clean `UNKNOWN_QUERY_PARAMETER` error rather than a query
that runs and means something else.

Values live for the session only, like the outputs. **ClickHouse: Reset Runbook
Parameters** asks again.

## Charts

A result with two columns — a label and a number, or a time and a number — gets a
**Chart** toggle. A time-like first column draws a line, because the order means
something; anything else draws bars.

The chart follows the filter and the sort, so what is drawn is what the rows
above it would have shown. A null is skipped rather than plotted as zero.

The toggle appears only when the result can actually be charted, so it is never
a control that does nothing.

## The shipped templates

| Template | What it works through |
|---|---|
| **Why is this cluster slow** | What is running now, what has been slow, what read far more than it returned, what failed |
| **Which parts are not merging** | Parts per table, merges in flight, the replication queue, where the disk went |
| **What is my query doing** | The plan with index pruning, then what it really cost per `system.query_log` |

Every one is read-only and is run against a real ClickHouse before release. The
test suite checks that each opens with prose, only reads, round-trips unchanged,
and explains every parameter it asks for.

## Writing your own

Start from a template, or from an empty file:

1. Lead with what you are trying to find out. The prose is not decoration — it is
   what makes the file useful to whoever is on call at 3am, including you.
2. One question per cell. A cell returning forty columns is a cell nobody reads.
3. Say what the output means *before* it, so the next step is obvious when the
   number is surprising.
4. Prefer `system` tables over guessing. `system.query_log`, `system.parts`,
   `system.merges`, `system.replication_queue` and `system.processes` answer most
   of it.
5. Keep it read-only where you can. A runbook that only reads is one anyone can
   run on a read-only profile without thinking about it.
