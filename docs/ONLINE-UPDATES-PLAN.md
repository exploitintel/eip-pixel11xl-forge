# Online image and update plan

Status: Slice 1 complete and phone-qualified; Slice 2 implementation in progress

## Objective

Make installation and updates small, predictable, and usable without changing
Forge provider or pipeline behavior or creating a second updater. The only
Forge API addition in this plan is read-only Agent-busy lifecycle status.

The completed design must:

- allow Park, Park when idle, and installer updates while publication is
  enabled;
- keep one `install.sh` entry point for clean installation and updates;
- stop embedding complete Docker image archives in every release;
- download only container layers the phone does not already have;
- preserve Forge configuration, provider keys, CVE state, and Docker data
  during an update;
- update an existing installation without requiring locally prepared firmware,
  KernelSU, or Docker Engine payloads; and
- promote selected tested Forge revisions rather than rebuilding a Pixel
  release for every Forge commit.

## Current problems

### Publication prevents lifecycle operations

The Pixel park proof currently refuses whenever
`EIP_CVE_PUBLISH_ENABLED=true`, before it inspects the existing run metadata,
queue, or durable publication intents. Consequently an otherwise idle phone
cannot Park, complete Park when idle, or enter the installer update path.

Forge already implements a shared maintenance admission record. While that
record is present, the UI and chat processes refuse new work starts and allow
already admitted work to finish. The Pixel host has not connected that
existing mechanism to its lifecycle commands.

### Releases contain complete image archives

The rc.7 release ZIP is 1,927,706,558 bytes. Its controller and operator image
archives are 1,831,180,800 and 273,058,304 bytes respectively. The current
package therefore approaches GitHub's 2 GiB per-asset limit and transfers both
images again for every release.

The controller image is already layered usefully. The Forge runtime layer is
currently about 39 MB, while the large tool layer changes much less often.
Transporting the image as a tar archive prevents Docker from reusing those
unchanged layers across releases.

## Decisions

1. Use Forge's existing maintenance admission record for Pixel lifecycle
   handoff. Do not add another verifier or lifecycle framework.
2. Publish the controller and operator as public GHCR images and identify each
   release image by immutable digest.
3. Keep the release ZIP for the installer, Pixel host payload, Forge Control,
   and revision metadata. Remove `controller.tar` and `operator.tar` from it.
4. Use the same `install.sh` for a new installation and an update. Existing
   state decides the mode; users do not need a second updater command.
5. Detect the mode before validating payloads. Only a fresh installation
   requires `prepare-firmware.sh` outputs. An update preserves the installed
   disk size and does not consume `--disk-gib`.
6. Reuse the existing source, operations, managed-skills, image-tag, and health
   rollback transaction for updates. Do not create a parallel rollback path in
   `install.sh`.
7. Keep updates operator-initiated from the user's computer for v0.1. The
   Android app may display the installed version and lifecycle state, but it
   will not download or install releases in this slice.
8. A Pixel release promotes one selected, tested Forge commit. Ordinary Forge
   commits do not automatically become Pixel releases.
9. Keep the current Wi-Fi-only support boundary. Cellular behavior is not part
   of this work.

## Slice 1 - restore Park and update admission

### Implementation

- Bind-mount `/data/docker/eip-cve-control` read-only into both controller
  services at `/run/eip-cve-control`.
- Set `EIP_CVE_MAINTENANCE_FILE` for UI and chat to
  `/run/eip-cve-control/maintenance-v1`.
- Add a read-only Agent-busy boolean to broker health, including the
  maintenance response. Reading it while maintenance is active must not spawn,
  load, or continue an ACP child.
- Make hostctl create the existing Forge maintenance record before a park
  proof. This prevents new runs, publications, queue drains, and Agent turns
  from being admitted during the handoff.
- Continue using the existing run, queue, and durable publication-intent
  inspection, plus the broker's Agent-busy status, to decide whether work is
  active.
- Remove the blanket rule that treats publication being enabled as active
  publication.
- `park` removes the maintenance record if immediate parking is refused.
- `park-when-idle` retains maintenance admission, lets existing work finish,
  and parks once the existing state inspection reports idle.
- `cancel-park-when-idle` removes both the pending request and maintenance
  admission.
- `start` keeps admission closed while the UI and broker processes start,
  reopens admission, and then requires normal UI and Agent-chat health. A
  maintenance-mode HTTP response alone is not readiness. If normal health
  fails, hostctl restores maintenance admission and reports failure with
  Docker left available for recovery.

### Acceptance

- With publication enabled and no active work, Park succeeds.
- With publication enabled and a durable publication intent, Park refuses and
  does not stop Docker.
- With an Agent turn active, Park refuses and does not stop Docker. Park when
  idle remains pending until the turn completes or the operator cancels it.
- Agent-busy inspection during maintenance does not spawn or load an Agent
  child.
- Park when idle admits no new work, lets existing work finish, and then parks.
- Cancelling Park when idle reopens work admission.
- Start reaches `READY` and reopens admission.
- Start does not report readiness solely because the maintenance-mode chat
  health route returned HTTP 200. Normal post-maintenance Agent health must
  pass.
- An existing-install update can reach its park step without changing the
  publication setting.
- The focused hostctl, state-inspector, Android contract, and full repository
  tests pass.
- The lifecycle is exercised on the connected phone with publication enabled:
  status, Park, Start, Park when idle cancellation, and final `READY`.

## Slice 2 - registry-backed releases and updates

### Image publication

- Build the Linux/arm64 controller from the exact commit in `FORGE_REVISION`.
- Build the Linux/arm64 operator from this repository with its base image
  pinned by digest.
- Publish both as public packages under the `exploitintel` GHCR namespace.
- Record the controller digest, operator digest, Forge commit, and Pixel
  commit in the release lock metadata.
- Inspect the published controller config and prove its Forge revision and
  source-snapshot labels match `FORGE_REVISION` and the packaged source
  archive. Prove the operator architecture and config identity as well.
- Use tags for human navigation only. The installer always pulls by digest.
- Prove both public packages can be pulled without registry credentials.
- Reuse registry-backed BuildKit cache so unchanged tool layers are neither
  rebuilt nor uploaded for ordinary Forge runtime changes.

### Package changes

- Stop accepting or copying `controller.tar` and `operator.tar` in the public
  package builder.
- Put the two public image references and digests in `forge.lock`.
- Keep the existing small Forge source archive because the phone uses it for
  compose and managed skill release operations.
- Split installer payload validation by detected mode. The update path must not
  require `docker-engine.tgz`, stock or KernelSU boot images, the KernelSU
  Manager APK, the host module, or a prepared kernel payload.
- Keep Google firmware and locally prepared boot inputs outside the public
  release exactly as they are now.

### Installer update path

For a phone with an existing installation, the user runs the latest release:

```sh
./install.sh --serial ADB_SERIAL
```

The installer then:

1. validates the supported phone, detects the existing qualified installation,
   and applies the update payload requirements rather than fresh-install
   requirements;
2. reads and preserves the existing Docker disk-size configuration;
3. starts only the Docker daemon if it is parked so registry operations are
   available;
4. pulls the controller and operator by their release digests before changing
   the running installation, so registry or storage failure leaves Forge live;
5. enters maintenance admission and visibly waits for pipeline, publication,
   and Agent work to become idle;
6. uses the existing deployment transaction to retain the previous source,
   operations, managed skills, and image tags;
7. activates the candidate source, operations, and images and recreates the
   stack;
8. proves UI and broker process liveness while maintenance remains active;
9. installs the Forge Control APK, reopens work admission, and requires
    normal UI and Agent-chat health rather than the maintenance response;
10. finalizes the transaction and prints `READY`; and
11. uses the existing transaction to restore the
    previous source, operations, managed skills, image tags, and running stack
    if candidate readiness fails before finalization.

Provider environment files, generated WebUI credentials, state, CVE evidence,
Docker storage, and existing Android setup are preserved. An update does not
wipe, flash firmware, recreate the Docker disk, or require
`prepare-firmware.sh`.

The first transition from a tar-installed release to GHCR may download the
complete image because the phone does not yet have registry layer metadata.
The installer must report the required download and free-space condition
before changing the running installation. Layer-reuse claims begin with the
second registry-backed release and must be measured on the phone rather than
assumed.

After a successful update, retain the active and immediately previous EIP
image versions for rollback. Remove only older EIP-owned image versions by
explicit identity; do not run a broad Docker prune.

### Acceptance

- A release package contains neither Docker image tar and remains well below
  the GitHub release-asset limit.
- A clean phone installation pulls the exact public image digests and ends in
  `READY`.
- Both image pulls succeed from a Docker client with no GHCR login or stored
  registry credential.
- Updating the existing qualification phone preserves its configuration and
  state and ends in `READY`.
- Updating from a freshly downloaded release does not require
  `prepare-firmware.sh`, bootstrap firmware, KernelSU, Docker Engine, module,
  or kernel payloads.
- An update preserves an existing 8, 16, 32, or 64 GiB disk configuration and
  never rewrites it to the installer default.
- A second update whose large tool layers already exist transfers only the
  missing layers, confirmed by observed phone-side pull output and byte use.
- A deliberately unhealthy candidate restores the previous working version.
- A maintenance-mode HTTP 200 from Agent chat is not accepted as final
  readiness; the normal broker health path must pass after admission reopens.
- An active Agent turn prevents immediate update parking and remains intact
  until it completes or the operator cancels it.
- The update works with publication enabled and does not ask the user to edit
  provider settings.
- Package, installer, public-tree, image provenance, and full repository tests
  pass before a new prerelease is published.

## Release sequence

1. Implement and qualify Slice 1 independently on the current tar-based
   release. Do not mix the park correction with registry transport.
2. Publish initial public GHCR controller and operator packages, prove an
   anonymous Linux/arm64 pull on the phone, and measure whether the tar-loaded
   layers are reused.
3. Implement and test Slice 2 without deleting the existing rc.7 release or
   assuming that its tar-loaded layers will be reused.
4. Prove an update from rc.7 to the registry-backed candidate on the current
   phone.
5. Prove the same candidate through the clean-install sequence.
6. Publish a new prerelease only after both proofs pass.

## Explicit non-goals

- no automatic background updates;
- no Android-native release downloader;
- no custom binary deltas or split image archives;
- no embedded registry credentials on user phones;
- no change to Forge provider behavior;
- no change to the Pixel kernel, Docker engine, disk format, or networking;
- no cellular support work; and
- no new signing, security, or hardening project as part of these slices.
