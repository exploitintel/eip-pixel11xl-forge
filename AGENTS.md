# eip-pixel11xl-forge working rules

This repository is the public Pixel 11 Pro XL distribution for Forge. It owns
the Pixel host layer, installer glue, Forge Control app, release packaging,
and the exact pinned Forge revision. Forge implementation remains in the
separate `eip-cve-public-v4` repository and is never vendored here.

## Safety boundary

- Repository work does not authorize flashing, rebooting, service restarts,
  firewall or routing changes, phone deployment, model calls, lab execution,
  remote publication, or GitHub settings changes.
- Never commit or publish Google firmware, boot or init_boot images, Docker
  data, credentials, device inventory, or private release keys. Users obtain
  their own factory ZIP from Google; the release preparation command extracts
  and verifies its required images locally.
- The only committed private-key-shaped file is
  `kernel/keys/reproducibility/signing_key.pem`. It is an intentionally public,
  non-secret D4 build fixture whose exact hash is allowlisted. It is not a
  release signing key and must never be trusted for authentication.
- Resolve Pixel defects against this repository's public contracts. Change
  Forge behavior in `eip-cve-public-v4`, then deliberately update
  `FORGE_REVISION` here.

## Compatibility boundary

- v0.1 supports only Pixel 11 Pro XL (`kodiak`) build
  `CD1A.260714.001.A9` over Wi-Fi.
- Cellular networking, automatic transport switching, and cellular ingress
  claims are out of scope for v0.1.
- Preserve the exact device, build, source, config, patch, key, toolchain,
  partition-size, and artifact-hash gates. Fail closed on unknown inputs.
- The module-signing fixture is valid only while signature enforcement remains
  disabled in both the shipped config and the separately qualified runtime.

## Change workflow

- Reproduce a defect or establish the violated invariant before changing
  behavior.
- Update the implementation, focused regression test, and owning documentation
  together.
- Run repository tests and public-material scans before handoff.
- Keep third-party Actions pinned by full commit SHA with minimal permissions.
- No direct pushes to `main`; use `feat/`, `fix/`, `chore/`, or `docs/` topic
  branches.
- Commit as `Exploit Intel <dev@exploit-intel.com>` with no AI attribution.
- Use plain hyphens in prose, commit messages, and pull request text.
