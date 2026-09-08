# Release and trust policy

The public `v0.1.0-rc.8` installer is a manually published, unsigned
prerelease for qualification. Its release asset is the supported public
installer path, but it is not a signed or stable release. The current
kernel-candidate and qualification-module workflows do not publish GitHub
releases. A separate, manually dispatched workflow may publish the public
controller and operator container images by digest. Protected automated
release publication, repository rulesets, immutable releases, and an offline
release key remain future work.

## Versions and immutable assets

- Prerelease tags use `v0.1.0-rc.N`; the first stable tag will be `v0.1.0`.
- Module `versionCode` begins at 1 and strictly increases for every tagged
  candidate. A value is never reused.
- Initial releases are prereleases. A second-device clean-room gate is required
  before a stable claim.
- Hotfixes receive a new patch version and higher `versionCode`. Published
  assets are never replaced in place.
- A protected tag must peel to the signed full commit immediately before
  publication. GitHub immutable releases must be enabled before the first
  stable release.

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
the first signed release, the operator creates it offline, stores two encrypted backups, commits
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
