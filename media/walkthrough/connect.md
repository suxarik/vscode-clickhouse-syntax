## Connect to a server

**ClickHouse: Add Connection** asks five questions and tests the answer, so a
typo surfaces now rather than at your first query.

```
localhost:18123
https://abc.clickhouse.cloud:8443
```

A bare host defaults to port 8123, or 8443 for `https`.

Passwords go to the OS credential store, never to `settings.json` — nothing
secret can end up in a commit.

**New profiles are read-only.** A write is refused outright, not prompted, until
you set `allowWrite` on that profile. A dialog you can click through is not a
safety boundary.
