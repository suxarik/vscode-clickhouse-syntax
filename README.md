# ClickHouse SQL — IDE & Runbooks

[![Marketplace](https://badgen.net/vs-marketplace/v/SuXarikisme.clickhouse-syntax)](https://marketplace.visualstudio.com/items?itemName=SuXarikisme.clickhouse-syntax)
[![Installs](https://badgen.net/vs-marketplace/i/SuXarikisme.clickhouse-syntax)](https://marketplace.visualstudio.com/items?itemName=SuXarikisme.clickhouse-syntax)
[![Downloads](https://badgen.net/vs-marketplace/d/SuXarikisme.clickhouse-syntax)](https://marketplace.visualstudio.com/items?itemName=SuXarikisme.clickhouse-syntax)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.txt)

Write ClickHouse SQL in an editor that understands the dialect, connect to a
server, run the statement under your cursor, and read the result — without
leaving the file.

Every completion, lint and quick fix comes from a **real parser and scope
binder**, not from pattern-matching text. Every function, type, engine and
setting comes from **ClickHouse's own introspection tables**, so the catalog
cannot drift from the dialect.

---

## Sixty seconds to a result

1. **ClickHouse: Add Connection** — paste `localhost:8123` or a ClickHouse Cloud
   URL. It asks five questions and tests the answer.
2. Open a `.sql` file, put the cursor in a statement.
3. **`Ctrl+Enter`** (`Cmd+Enter`).

New profiles are **read-only**. Passwords go to the OS credential store, never
to `settings.json`.

---

## What it does

### 🔌 Connect and run

- **`▷ Run` and `Explain` above every statement**, or `Ctrl+Enter` /
  `Ctrl+Shift+Enter` for the one under the cursor. No selecting required. A
  destructive statement says so in the lens, before anyone clicks it.
- **Results stream in** as they arrive, in a virtualised grid — a million rows
  arrive in about 1.6 seconds and render as fewer than eighty DOM nodes.
- **Sort, filter, resize.** Drag a column edge, or double-click it to fit the
  contents. Expand nested `Array` / `Map` / `Tuple` / `JSON` cells in place.
- **Copy or export** as TSV, CSV, JSON or Markdown.
- **Charts** for a two-column result — a label and a number gives bars, a time
  and a number gives a line. Inline SVG in your theme's colours.
- **Cancel** sends `KILL QUERY`, so the work stops on the server rather than the
  connection merely being dropped.
- **64-bit integers stay exact.** They cross the wire as strings, because
  `JSON.parse` rounds anything past 2⁵³. Sorting uses `BigInt`, so the order is
  right too.
- **Browse the schema** in the explorer: the server, its databases, their
  tables and columns with types, row counts, part counts, dictionaries. It says
  so when it is showing a cache whose refresh failed — a stale schema never
  passes for a live one.
- **The tree says what it is connected to.** One node or a cluster, with its
  own icon. Each table carries an icon for its engine, so a
  `ReplacingMergeTree` that will need `FINAL`, a view that stores nothing and a
  table whose rows live in S3 are told apart while scanning rather than read
  one at a time. A profile allowed to write is marked in ClickHouse orange —
  worth knowing before you type, not after a dialog appears.
- **Preview Rows opens the query**, then runs it. A preview is something you
  want to change — add a `WHERE`, raise the limit — so the statement arrives as
  SQL you can edit and run again, not as a result with the query hidden.
- **Query history** with timings and re-run, and **pin** the queries worth
  keeping: pinned entries survive the cap and survive clearing.

### 🧭 Understand a query before you run it

- **EXPLAIN as a plan, not as text** — `PLAN indexes = 1`, `PIPELINE`,
  `ESTIMATE`, `SYNTAX`, `AST`, rendered as a tree that leads with what matters:
  which tables are read and how much each index actually removed
  (`parts 1/3 (33.3%)  granules 8/24 (33.3%)`). It says plainly when nothing was
  pruned.
- **`◉ Analyze` draws where the time actually went.** Explain predicts; Analyze
  runs the query and reads `system.processors_profile_log`, so every operator
  carries its real CPU time, rows in and out, and how long it sat waiting. The
  plan text and the drawing share one panel, split and resizable, and selecting
  an operator marks the line the server wrote it on.

  Two drawings of the same graph, switchable: a **flame** where width is time,
  so the bottleneck is simply the widest bar, and a **node-link graph** where a
  box's size is its cost and an edge's thickness is the rows crossing it. Runs
  of steps too small to matter fold into one, so a pipeline stays readable
  rather than becoming a wall of equal boxes. **Fit** and **1:1** control the
  zoom; **SVG**, **PNG** and **JPG** save the drawing.

  CPU time and wall clock are reported side by side and never conflated — a
  query can burn 82 ms of CPU inside 31 ms of wall clock across eighteen
  threads, and the panel says so rather than picking one and calling it
  duration.

  Analyze **executes**, so it is offered on reads only, and refuses anything
  else however the profile is configured. It runs the query with `FORMAT Null`:
  the server does all the work and returns no rows, so no production data is
  fetched to draw a picture of it.

  **In runbooks too** — a query cell has an Analyze action that puts the same
  view in the cell's own output, so an incident note keeps the evidence beside
  the step that found it.

- **Validate against the real server** on demand, via `EXPLAIN QUERY TREE` —
  which resolves every name without reading a single row.
- **Profile the last query** from `system.query_log`: duration, rows and bytes
  read, peak memory, thread count.
- **17 lint rules** for what a plan will not tell you — a missing `PREWHERE`, a
  `SELECT *`, a `JOIN` without a condition, a `ReplacingMergeTree` read without
  `FINAL`. Each is individually configurable, with inline
  `-- ch-lint-disable-next-line`. See [docs/rules.md](docs/rules.md).

### 📓 Runbooks

Incident work is prose, a query, its output, then the next step. **ClickHouse:
Open a Runbook Template** starts you with one that already knows the system
tables — *why is this cluster slow*, *which parts are not merging*, *what is my
query doing*.

A runbook is a **plain `.sql` file** with `-- %%` cell markers. No JSON
container, so it stays a script you can pipe to `clickhouse-client`, diffs stay
readable, and any `.sql` file opens as one.

- **Outputs are never written to the file.** The format has nowhere to put one —
  a file that persists query results is a way for production rows to end up in a
  commit.
- **The kernel picker is the connection picker**, one per profile, each stating
  what it is allowed to do. A cell goes through the same gate as the editor.
- **Parameters.** `{start:Date}` is prompted for once and sent as ClickHouse's
  own query parameter, so the **server** substitutes it with the declared type —
  a value typed into a box can never be an injection.

Full details in [docs/runbooks.md](docs/runbooks.md).

### 🖧 Clusters

**ClickHouse: Show Cluster** draws shards across and replicas down, with the
findings beside it: a host that did not answer, a shard short of replicas, a
read-only replica and how long it has been one, replication lag, a queue that
is not draining, lost parts, an expired Keeper session.

And **where the rows actually are**. A sharding key is a promise about
distribution that nothing checks — sharding by a column with three distinct
values across two shards puts 66.7% of the rows on one of them, and the cluster
is then only as fast as its busiest node. No single node can see it; each looks
perfectly healthy holding whatever share it was given. Replicas of one shard
are compared with each other too, since they should hold the same rows.

Every box is the same size, because a cluster is a map rather than a
measurement. The bar inside each box is the measurement.

Analyze knows about shards too: when a query was distributed, the findings say
what each shard was asked to read and whether that was even.

Everything here reads. A cluster is looked at during an incident, which is
exactly when a tool should not be able to make anything worse.

### 🧱 dbt and migrations

**dbt models parse.** `{{ ref('users') }}`, `{% if is_incremental() %}` and
`{{ config(...) }}` no longer light a model up with errors. If the project has
been compiled, `ref()` and `source()` resolve through `target/manifest.json`, so
a model's columns are known and completion inside `ref('…')` offers model names.

**ClickHouse: Compare Schema File with Server** diffs your schema file against
the live server and opens the `ALTER TABLE` script. Anything that could lose data
is written out but **commented** — nothing is applied for you.

**ClickHouse: Scaffold a Table** writes the local table, the `Distributed` table
in front of it, and an `AggregatingMergeTree` rollup with its materialized view,
in the order they have to run.

### 🤖 Hand it to an agent

Copilot agent mode — and anything else that speaks VS Code's tool API — can use
the connection you already configured, through three tools:

| Tool | `#` reference | What it does |
| --- | --- | --- |
| Run a ClickHouse query | `#chquery` | Runs a **read-only** query and returns the rows |
| List ClickHouse tables | `#chtables` | Databases, tables, engines and row counts |
| Describe a ClickHouse table | `#chdescribe` | Columns, types, defaults and comments |

**An agent may only read.** A profile with `allowWrite` lets *you* write, after a
confirmation you can see; nothing an agent sends is seen before it runs, so the
tools refuse every write — `INSERT`, `ALTER`, `DROP`, `DELETE`, `UPDATE`,
`SYSTEM` — whatever the profile permits. The same parse-tree classification
guards it, and `readonly` goes with the request regardless, so the server
refuses it too. There is no second credential path: it is your profile, your
password in the OS keychain, your row cap.

### ✍️ Write the SQL

- **Scope-aware completion.** `e.` offers the columns of whatever `e` aliases,
  through CTEs and subqueries. Clause-specific lists: settings inside `SETTINGS`,
  formats after `FORMAT`, engines after `ENGINE =`. Silent inside strings and
  comments.
- **The `system` database is built in** — `FROM system.` completes all 155
  system tables and their columns with no configuration at all.
- **Table functions** — `FROM s3(…)`, `iceberg(…)`, `remote(…)`, `numbers(…)`.
  All 95 of them, with the signature on hover, and a note when one cannot be
  used on a read-only connection.
- **Hover** for any function: signature, description, return type, examples, and
  a link to the official docs.
- **Signature help** while typing a call, with the active parameter highlighted.
- **Quick fixes**: expand `SELECT *`, convert to `PREWHERE`, `CASE` ↔ `multiIf`.
- **40+ snippets** — `ctm` (MergeTree), `ctrm` (Replicated), `ctd`
  (Distributed), `cmv` (materialized view), `cdict`, `cte`, `win`, `amap`,
  `quantile`, and more.
- **Version gating.** Set `clickhouse.serverVersion` and functions introduced
  after it disappear from completion.

### 🎨 Highlighting and formatting

Full syntax highlighting for ClickHouse types, engines and keywords — `PREWHERE`,
`SAMPLE`, `FINAL`, `ARRAY JOIN`, `WITH TOTALS`, `TTL`, `CODEC`. ClickHouse syntax
is also injected into plain `.sql` files, so you get it without changing the
file's language.

The formatter puts each clause on its own line and expands column lists and
conditions. It is **idempotent**, and it **never rewrites your identifiers** — a
column named `first`, `range` or `table` keeps its casing, and `left(s, 2)` stays
`left`.

<details>
<summary>Before and after</summary>

```sql
select user_id,count() as cnt,sum(revenue) as rev from events where event_date>=today()-30 and status='active' group by user_id order by cnt desc limit 100
```

```sql
SELECT
    user_id,
    count() AS cnt,
    sum(revenue) AS rev
FROM events
WHERE
    event_date >= today() - 30
    AND status = 'active'
GROUP BY
    user_id
ORDER BY
    cnt DESC
LIMIT 100
```

</details>

---

## Safety

This is the part worth reading twice, because it is the part that decides what
happens when you are tired and pointed at production.

| Profile | What it may do |
| --- | --- |
| *(default)* | **Read-only.** Anything that is not a read is **refused**, not prompted |
| `allowWrite: true` | Writes permitted, each confirmed first |
| `protected: true` | Writes additionally require the profile name to be typed |

Read-only is a **refusal, not a dialog**. A prompt you can click through is not a
safety boundary, so a read-only profile will not send an `INSERT` at all.

Two checks run independently:

1. The statement is classified from the **parse tree**, so a `DROP` inside a
   string literal or a comment is not mistaken for one.
2. `readonly=2` is sent with the request, so **ClickHouse refuses it too**.

A statement this extension has never heard of counts as a **write**, not a read.
ClickHouse adds statements every month, and a new one must not arrive already
classified as harmless.

Destructive statements — `DROP`, `TRUNCATE`, `DELETE FROM`, `ALTER … DELETE`,
`SYSTEM` — always confirm, naming the profile and the target. The active
profile is always in the status bar. Credentials live in the OS credential
store and are sent as headers, never in the URL. Connections are disabled in
restricted-mode workspaces.

A notebook cell goes through **the same code**, so a runbook cannot become a way
around any of this.

Full reference: [docs/connections.md](docs/connections.md).

---

## Generated from ClickHouse itself

The catalogs are not hand-maintained lists. They are read out of a running
server's own introspection tables by `npm run catalog`, and the grammar's
function lists are generated from the same source — so highlighting and
IntelliSense can never disagree.

| Catalog | Entries |
| --- | --- |
| functions | 1918 (1683 documented) |
| table functions | 95 |
| data types | 141 |
| table engines | 83 |
| settings | 2226 |
| formats | 114 |
| `system` tables | 155 |

**ClickHouse: Show Catalog Info** reports which server version the shipped
catalog came from.

---

## Commands

47 commands, all under **ClickHouse:** in the palette. The ones worth knowing:

| Command | What it does |
| --- | --- |
| Add Connection | Guided setup; tests the result |
| Run Query · Run Statement at Cursor | `Ctrl+Enter` |
| Explain Query | `Ctrl+Shift+Enter` — the plan, without running the query |
| Analyze Query | Runs it and draws where the time went |
| Show Cluster | Shards, replicas, and where the data sits |
| Advise on Schema | What several analysed queries had in common |
| Cancel Query | Sends `KILL QUERY` |
| Profile Last Query | Real counters from `system.query_log` |
| Show Query History | Re-run, and pin what matters |
| Open a Runbook Template | Three, for incident work |
| Compare Schema File with Server | The `ALTER` script, to read first |
| Scaffold a Table | Local + Distributed + rollup |
| Diagnose Connection | Layer-by-layer, when it will not connect |
| Show Performance Stats | Measures its own budget |

---

## Settings

49 settings, all under `clickhouse.` in the Settings UI. The ones people change:

| Setting | Default | What it controls |
| --- | --- | --- |
| `clickhouse.connections` | `[]` | Server profiles. Secrets are stored separately |
| `clickhouse.query.maxResultRows` | `100000` | Rows pulled into the grid (`0` for no cap) |
| `clickhouse.query.maxExecutionTime` | `60` | Seconds before the server aborts |
| `clickhouse.query.previewRows` | `100` | Rows fetched by **Preview Rows** |
| `clickhouse.schema.source` | `both` | `connection`, `file` or `both` |
| `clickhouse.query.showExplainCodeLens` | `true` | The **Explain** action above each query |
| `clickhouse.detect.mode` | `prompt` | Whether a `.sql` file may be switched to ClickHouse SQL |
| `clickhouse.format.keywordCase` | `upper` | `upper`, `lower`, `preserve` |
| `clickhouse.serverVersion` | *(unset)* | Hide functions newer than your server |

Host, user and database accept `${env:VAR}`, for CI and dev containers.

---

## Files it opens

| Pattern | Opened as |
| --- | --- |
| `.chsql`, `.ch.sql` | ClickHouse SQL |
| `.sql` | Highlighted via injection; offers to switch language when it detects ClickHouse syntax |
| `.runbook.sql`, `.chnb.sql` | Opens as a runbook notebook |

Language detection **asks first** and remembers the answer per file. It never
silently rewrites a document's language.

---

## Requirements

- VS Code **1.95** or newer.
- ClickHouse **22.x** or newer for the query features. The language features work
  with no server at all.
- Works in [vscode.dev](https://vscode.dev) — there is a web build, and HTTP is
  the only transport, so nothing needs a raw socket.

---

## Documentation

| Document | Covers |
| --- | --- |
| [docs/connections.md](docs/connections.md) | Profiles, token auth, TLS, the safety flags, reading a failed diagnosis |
| [docs/runbooks.md](docs/runbooks.md) | The cell format, parameters, charts, writing your own |
| [docs/rules.md](docs/rules.md) | All 17 lint rules, generated from the rule registry |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and why |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Architecture, build, tests |

---

## License

MIT — see [LICENSE.txt](LICENSE.txt).
