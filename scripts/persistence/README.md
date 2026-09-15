# Persistence validation

Run the complete gate from a source install (`bun install --frozen-lockfile
--ignore-scripts` works):

```sh
bun --no-env-file scripts/persistence/validate.ts --engine=pglite
DATABASE_URL=postgres://test-user:test-password@localhost:5432/gbrain_test \
  bun --no-env-file scripts/persistence/validate.ts --engine=postgres
```

Postgres requires a test-shaped database URL and permission to create and drop
databases. Every phase gets a fresh, randomly named `gbrain_persistence_test_*`
database. The runner drops only those databases. PGLite uses temporary disk
datastores, reopened in separate processes. Child homes and writer lock paths
are temporary; no operator brain or provider credentials enter children.

The default gate executes, per engine:

| Workload | Required result |
| --- | --- |
| 1,000 seeded schedules (seed 5105) | 100 executions of each of the ten cases below; every schedule checks exact journal counter conservation and no leftover claimable work |
| Six actual SIGKILL boundaries | Acknowledged requests survive reopening; unfinished file effects recover; committed DB/file/receipt state stays committed; original request replay returns the same outcome |
| 10,000 logical writes | Four independent producer processes, four principals and four source roots; every request commits once; every canonical snapshot and file matches the receipt; zero pending requests or unresolved recovery records |

The ten schedule families are concurrent identical/changed-intent replay;
competing creates and replacements using one revision; cancellation versus publication; rollback/lost response
at all five coordinator hooks; obsolete claim renewal/release; FIFO within
each root with unrelated-root progress; MVCC/serialized coherent reads;
unexpected external file bytes blocking recovery; concurrent quota admission;
and revocation after acceptance. A seeded PRNG varies principals, roots,
payloads, concurrent widths and submission order. Real production coordinator
hooks control transaction and filesystem boundaries. This is a bounded
schedule sample, not exhaustive model checking.

The crash cases kill a process after admission, durable prepare, immediately
before and after file publication, before commit and after commit. The
PGLite case exercises the datastore owner's death. The Postgres case kills
the client/owner process while the database server remains running. These
are process-crash RPO=0 checks; they do not simulate power loss, storage
controller failure or database-server loss.

Postgres runs two resident consumers and producers with independent database
connections. PGLite has one resident owner; producer processes submit through
a **fixture-only loopback endpoint** into the real admission API. That
endpoint does not test production authentication or MCP/IPC framing; the
existing receipt and transport suites cover those contracts. Both engines
use the real consumer, authority checks, kernel locks, coordinator, durable
files and database transactions. Four writes per producer stay in flight;
every seventeenth logical write is replayed under the same request ID.

The default manifest is `.context/persistence-<engine>-manifest.json`. It
contains the actual completed case counts, crash outcomes, runtime/platform,
latency distributions (p50/p95/p99/max), concurrent canonical-read checks, throughput, peak resident RSS,
duplicate replay count, per-phase source hashes and final accounting results. A failed run writes a
failed manifest. Smaller runs (`--schedules=50 --operations=64`) are useful
for iteration and always report `full_gate: false`; `--no-crashes` does too.
Use `--seed=...` for another reproducible sample and `--manifest=...` to keep
multiple records. Performance numbers describe a synthetic body+timeline+tag
workload with a durable file per write; they exclude provider calls, Git
publication and remote network latency. Compare like-for-like runtime,
storage and process counts before setting or changing latency budgets.

`persistence-validation.yml` runs the full gate on Linux x64 for both engines
under Bun 1.3.11 and 1.3.13 and uploads every manifest. Native OS/architecture
coverage is separately required by `native-locks.yml`; its configured matrix
must not be mistaken for locally executed runtime evidence.

The same workflow executes `scripts/persistence/matrix.ts`, requiring both
`DATABASE_URL` (direct test connection) and `GBRAIN_PGBOUNCER_URL` (a real
transaction-mode pooler with wildcard database routing). Its 24 cells cover
direct/pooler transport, RLS on/off under a non-superuser role, ordinary pools
1/2/3 and shared pools versus a separate direct pool of size one. Each cell
proves short control progress while the production bulk reservation API
holds every permitted long-running slot. Size one keeps canonical work
queued with `writer_pool_capacity`; sizes two and three commit the same
request after bulk work drains. A separate fixture checks manifest-verified
transfer between distinct host identities/checkouts, stale-owner refusal,
retained coordination paths across root replacement and source-incarnation
fencing. The default matrix manifest is
`.context/persistence-runtime-matrix.json`; missing mandatory URLs fail the
standalone gate. The ordinary E2E entry skips outside a configured pooler
lane and refuses to skip when `GBRAIN_CI_REQUIRE_PGBOUNCER=1`.

The heavy process worker allows 90 minutes; its CI job allows 110 minutes.
This accommodates disk-PGLite durability on slower VM storage without
reducing the 10,000 actual mutation requirement.
