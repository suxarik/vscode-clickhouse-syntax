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
- **Browse the schema** in the explorer: databases, tables, columns with types,
  engines, row counts, part counts, dictionaries. It says so when it is showing
  a cache whose refresh failed — a stale schema never passes for a live one.
- **Query history** with timings and re-run, and **pin** the queries worth
  keeping: pinned entries survive the cap and survive clearing.

### 🧭 Understand a query before you run it

- **EXPLAIN as a plan, not as text** — `PLAN indexes = 1`, `PIPELINE`,
  `ESTIMATE`, `SYNTAX`, `AST`, rendered as a tree that leads with what matters:
  which tables are read and how much each index actually removed
  (`parts 1/3 (33.3%)  granules 8/24 (33.3%)`). It says plainly when nothing was
  pruned.
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

### ✍️ Write the SQL

- **Scope-aware completion.** `e.` offers the columns of whatever `e` aliases,
  through CTEs and subqueries. Clause-specific lists: settings inside `SETTINGS`,
  formats after `FORMAT`, engines after `ENGINE =`. Silent inside strings and
  comments.
- **The `system` database is built in** — `FROM system.` completes all 134
  system tables and their columns with no configuration at all.
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

Destructive statements — `DROP`, `TRUNCATE`, `ALTER … DELETE`, `SYSTEM` — always
confirm, naming the profile and the target. The active profile is always in the
status bar. Credentials live in the OS credential store and are sent as headers,
never in the URL. Connections are disabled in restricted-mode workspaces.

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
| functions | 1858 (1630 documented) |
| data types | 140 |
| table engines | 83 |
| settings | 2071 |
| formats | 112 |
| `system` tables | 134 |

**ClickHouse: Show Catalog Info** reports which server version the shipped
catalog came from.

---

## Commands

41 commands, all under **ClickHouse:** in the palette. The ones worth knowing:

| Command | What it does |
| --- | --- |
| Add Connection | Guided setup; tests the result |
| Run Query · Run Statement at Cursor | `Ctrl+Enter` |
| Explain Query | `Ctrl+Shift+Enter` — the plan, without running the query |
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

48 settings, all under `clickhouse.` in the Settings UI. The ones people change:

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

- VS Code **1.86** or newer.
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
