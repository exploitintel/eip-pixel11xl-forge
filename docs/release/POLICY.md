# Release and trust policy

The current kernel-candidate and qualification-module workflows do not create
or publish a GitHub release. The module workflow retains only a
commit-qualified, installable but unsigned qualification artifact for 14 days.
It is not a public release. No release workflow exists yet. Remote
environments, rulesets, immutable releases, and the offline release key require
separate operator-controlled setup.

## Versions and immutable assets

- Release tags use strict three-part SemVer, beginning with `v0.1.0`.
- Module `versionCode` begins at 1 and strictly increases for every tagged
  candidate. A value is never reused.
- Initial releases are prereleases. A second-device clean-room gate is required
  before a stable claim.
- Hotfixes receive a new patch version and higher `versionCode`. Published
  assets are never replaced in place.
- A protected tag must peel to the signed full commit immediately before
  publication. GitHub immutable releases must be enabled before v0.1.

## Canonical manifest

`SHA256SUMS` is UTF-8/ASCII, LF terminated, and contains exactly one row per
payload asset in bytewise filename order:

```text
64-lowercase-hex-characters  flat-asset-name
```

There are exactly two spaces between digest and name. Comments, blank rows,
duplicate names, absolute paths, path separators, dot segments, wildcard
syntax, and undeclared assets are forbidden. The payload allowlist and manifest
must be exactly equal.

`SHA256SUMS`, `SHA256SUMS.minisig`, Sigstore bundles, and GitHub-generated
metadata are trust metadata and are not self-hashed. A covered
`release-metadata.json` identifies the schema, repository, tag, full commit,
source ref, signer workflow, channel, module version/versionCode, and exact
build compatibility.

## Offline minisign key

The release private key never enters Git, GitHub Actions, or a device. Before
v0.1, the operator creates it offline, stores two encrypted backups, commits
only the public key, and publishes the SHA-256 of the exact public-key file
bytes through an independent operator-controlled channel.

Routine rotation requires an old-key-signed transition naming the replacement
fingerprint. If the key is lost or compromised, the emergency process states
that continuity cannot be proved and establishes a new trust root without a
false continuity claim.

## Publication boundary

A later protected workflow may assemble a draft prerelease. It must not publish
it. After offline signing, a separately authorized publication step downloads
the final draft again and verifies the asset inventory, manifest signature,
hashes, attestations, protected tag target, and immutable-release setting.
Only then may it publish the already-qualified bytes.
