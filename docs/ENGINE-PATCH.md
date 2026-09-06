# Docker Engine path patch

Android does not provide the conventional writable `/run` hierarchy expected
by Docker Engine. The public patch record makes only three same-length path
substitutions in the exact Docker 29.8.0 AArch64 static archive recorded in
`tools/engine.json`:

| From | To |
| --- | --- |
| `/run/containerd` | `/dev/containerd` |
| `/run/docker/plugins` | `/dev/docker/plugins` |
| `/run/docker/metrics.sock` | `/dev/docker/metrics.sock` |

`engine.json` binds the archive size and SHA-256 plus every original member's
size and SHA-256, replacement counts, unchanged output size, and final SHA-256.
Any mismatch is a refusal. Other `/run/docker` strings are deliberately
untouched.

`patch-engine.py` owns host-side download, archive verification, extraction,
and complete-directory reconstruction. It accepts only strict, case-distinct
binary basenames and creates each result relative to the newly created output
directory without following links or replacing a path. Its download cache must
be a real directory owned by the current user and not writable by group or
other users.
Downloads use an unpredictable create-only temporary file inside that pinned
directory, pass the recorded size and SHA-256 gates before create-only cache
publication, and never reuse a symlink or non-regular cache entry.

`patch-engine.c` is the smaller archive-independent primitive intended for the
module. Its caller must first verify and extract the pinned archive, then invoke
it once per member with the mandatory input size, input hash, output hash, and
ordered replacement rules. It creates a new mode-0755 output without replacing
an existing path and verifies the bytes again before publication. It performs
no network access, archive parsing, JSON parsing, or in-place modification.

The C and Python paths share byte-parity tests. The module workflow also runs a
host build of the C tool over every member of the real pinned archive and
compares those results with the Python reconstruction. The separately built
static AArch64 executable is inspected for architecture and dynamic
dependencies; executing that exact artifact remains a later device gate.

The deterministic module assembler copies the eight verified output sizes and
hashes from `engine.json` into its generated `release-manifest.tsv`. It adds
the four non-engine runtime records from the exact packaged bytes. This binds
the future transaction input without putting Docker binaries in the ZIP; the
manifest remains integrity metadata until the containing release is
authenticated by the future offline signature path.

The project downloads but does not redistribute Docker Engine, containerd,
runc, or Docker CLI object code. See `NOTICE.md` for upstream attribution and
the trademark disclaimer.
