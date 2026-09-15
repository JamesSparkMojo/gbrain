# Canonical writer enforcement

Managed persistence is an explicit activation boundary. Page bodies, frontmatter,
visibility, tags, aliases, facts, takes, timeline rows, source identity/path and
sync checkpoints require coordinator authority. The checked-in
[writer census](canonical-writers.tsv) lists every engine-method/SQL reference to
those writes plus the filesystem and git escape paths. Its test rejects a new
file or an increase in write references until the enforcement route is reviewed.
This lexical census intentionally includes comments; it supplements runtime
checks rather than proving arbitrary JavaScript safe.

Supported page, memory, tag, timeline and take operations use the durable journal.
Their receipts become committed only with the canonical transaction. Prepared
imports compare the observed page identity/revision before installing bodies,
versions, tags or chunks. A same-body hash is insufficient for a prepared no-op:
canonical metadata and additive tags must also match. Legacy hash repairs and
unchanged-file skips acquire the same page guard and compare revisions.

Unsupported direct writers fail closed after managed activation. SQL triggers
cover pages, tags, slug aliases, free-text aliases, facts, takes, timeline entries
and sources. Physical embeddings/index telemetry remain projections. Import,
source clone/remove/reclone/archive/restore/purge, connector sync, legacy sync,
engine migration, manual link edits, schema link rewrites, synthesis, patterns
and phantom redirect refuse before their first canonical side effect. Legacy
maintenance that reaches a canonical engine mutation is rejected by the SQL
trigger. Extracted links are derived projections; manually authored link API
writes remain refused until a coordinator callback exists. Links authored in
Markdown are reconciled by the coordinated import transaction.

Filesystem helpers check managed roots before atomic writes, frontmatter backup,
schema-pack replacement, clone, staging, pull or rebase. The registry stores one
0600 record per brain/root under the private configuration directory; records
retain source incarnation, worktree and topology generation when known. Existing
ancestors are resolved through symlinks, including a not-yet-created target.
Records are refreshed when an engine connects and remain usable before a second
process opens local PGLite. Stale records conservatively refuse writes until a
verified drain and explicit administration cleanup. A shared 0600 refusal marker
inside git metadata (or `.gbrain-managed` for non-git roots) also protects supported
commands using another home. Marker existence never grants publication authority.

The native worktree lock and database ownership rows grant authority. Registry
files and markers only refuse unsupported writes; copying a marked tree may
therefore require administration cleanup. Generated durability hooks honor that
refusal. Activation must quiesce older binaries and external writers because
programs that do not implement this protocol cannot be constrained by application
checks. Direct SQL administration, external editors and arbitrary shell commands
remain outside the supported writer protocol. Migration and rollback after
managed commits require verified drain and forward repair, preserving the
journal, source incarnation and canonical revisions.
