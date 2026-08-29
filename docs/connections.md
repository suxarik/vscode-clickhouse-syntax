# Connecting to ClickHouse

Everything about connections is opt-in and reversible. A profile does nothing
until you select it, cannot write unless you say so, and never stores a secret
in a file.

## Adding a connection

**ClickHouse: Add Connection**, the `+` in the explorer, or the status bar when
nothing is configured yet. It asks five questions and tests the result, so a
typo surfaces immediately rather than at your first query.

The address accepts whatever you have to hand:

```
localhost:18123
ch.internal
https://abc.clickhouse.cloud:8443
```

A bare host defaults to port 8123, or 8443 for `https`.

## Where things are stored

| | Where | Why |
|---|---|---|
| Profiles | `clickhouse.connections` in user or workspace settings | Shareable, reviewable, diffable |
| Passwords and tokens | The OS credential store, via VS Code `SecretStorage` | Never in a file that can be committed |
| Query results | Nowhere | Rows are not written to disk (see [notebooks](#a-note-on-notebooks)) |

Choosing **Workspace** at the last step writes the profile to
`.vscode/settings.json`, which is usually committed — fine for a shared
development server, wrong for anything whose hostname is sensitive. **User
settings** keeps it to your machine.

## Authentication

```jsonc
{ "name": "local", "host": "localhost", "port": 18123 }                    // user + password
{ "name": "cloud", "host": "abc.clickhouse.cloud", "protocol": "https",
  "auth": "token" }                                                         // bearer token
```

`password` sends `X-ClickHouse-User` and `X-ClickHouse-Key`. `token` sends
`Authorization: Bearer …` and no user header, which is what ClickHouse Cloud and
JWT-fronted deployments expect. Either way the secret is stored separately —
**ClickHouse: Set Connection Password** puts it in the credential store.

Credentials are always sent as headers, never in the URL, so they stay out of
server logs and proxy logs.

## What a profile is allowed to do

This is the part worth reading twice.

```jsonc
{ "name": "prod", "host": "ch.internal", "protocol": "https",
  "allowWrite": true, "protected": true }
```

| Flag | Effect |
|---|---|
| *(neither)* | **Read-only.** Anything that is not a read is refused outright — not prompted |
| `allowWrite: true` | Writes permitted, each one confirmed first |
| `protected: true` | Writes additionally require the profile name to be typed |

Read-only is a **refusal, not a dialog**. A prompt you can click through is not a
safety boundary, so a read-only profile will not send an `INSERT` at all.

Two checks run independently:

1. The statement is classified from the parse tree, so a `DROP` inside a string
   literal or a comment is not mistaken for one.
2. `readonly=2` is sent with the request, so ClickHouse refuses it as well.

Destructive statements — `DROP`, `TRUNCATE`, `ALTER … DELETE`, `SYSTEM` — always
confirm, naming the profile and the target. `ALTER … ADD COLUMN` is treated as a
write; `ALTER … DROP COLUMN` as destructive.

The active profile is always named in the status bar, marked read-only or
protected, with a warning colour on protected ones.

## Environments and CI

`host`, `user` and `database` accept `${env:VAR}`:

```jsonc
{ "name": "ci", "host": "${env:CLICKHOUSE_HOST}", "user": "${env:CLICKHOUSE_USER}" }
```

Connections are **disabled in restricted mode**, because profiles come from
workspace settings and a repository should not be able to point the extension at
a host of its choosing.

## TLS

`https` verifies certificates. For a server with a self-signed certificate you
trust:

```jsonc
{ "name": "internal", "host": "ch.internal", "protocol": "https",
  "allowInvalidCertificate": true }
```

This disables the protection TLS exists to provide. It is per-profile and off by
default.

## When it will not connect

Run **ClickHouse: Diagnose Connection**. It reports, layer by layer, whether the
port is reachable, which transports answer, and whether the size of the response
is what breaks — rather than leaving you to guess.

Two things it is worth knowing to read the output:

- **If `tcp connect` fails**, the extension host cannot reach the server at all.
  The usual cause is a remote window — SSH, WSL, a dev container — where
  `localhost` is a different machine from the one the server runs on.
- **`localhost` resolves to IPv6 first** on most systems. A server listening only
  on IPv4 used to hang here; requests now race both families, so this should no
  longer bite. `127.0.0.1` remains a way to force the issue.

The explorer says so when it is showing a cached schema whose refresh failed, so
a connection that has stopped working cannot pass for a healthy one.

## Limits

| Setting | Default | |
|---|---|---|
| `clickhouse.query.maxResultRows` | `100000` | Rows pulled into the grid |
| `clickhouse.query.maxExecutionTime` | `60` | Seconds before ClickHouse aborts the query |
| `clickhouse.query.previewRows` | `100` | Rows fetched by **Preview Rows** |

Cancelling sends `KILL QUERY`, so the work stops on the server rather than the
connection merely being dropped.

## A note on notebooks

Notebooks are planned for 2.1 as `.sql` files with `-- %%` cell markers, and
their outputs will be **ephemeral by design**. A file that persists query results
is a way for production rows to end up in a commit; that is not a default worth
having.
