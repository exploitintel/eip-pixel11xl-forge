# Kernel reproducibility contract

The recorded local Phase C candidate baseline is intentionally distinct from
an earlier private build identity. It uses the committed D4
reproducibility-only keypair and was established by two clean builds in
separate workspaces at different wall-clock times.

Each build verifies, before compilation:

- full upstream commit and Git tree identity;
- normalized source archive SHA-256 and source manifest SHA-256;
- every patch, config, and D4 key/certificate hash;
- patched source manifest SHA-256;
- selected `linux/arm64` platform, pinned base manifest, and final builder
  config digest;
- module-signature enforcement options remain disabled.

The source and object layout remains `/ksrc/common` and `/ksrc/out`. The fixed
build host, user, link counter, banner timestamp, and built-in initramfs time
are part of `kernel/builds.json`. The build does not reuse a pre-existing image
tag, source volume, build cache, or package cache. The caller supplies the
exact hash-checked source archive.

Candidate outputs include a build-ID-qualified `Image.lz4`, exact normalized
source archive, config, patches, source manifests, `build-record.json`, and
`toolchain.txt`. Generated binaries and source archives are release artifacts,
not tracked source files.

The deliberately public D4 private key is checked before and after each build.
If its bytes change, if Kbuild regenerates it, or if signature enforcement is
enabled, the build fails. This key provides byte stability only. It provides no
authentication.

## Recorded local candidate

On 2026-09-06, two clean current-contract builds produced identical candidate
directories. The recorded arm64 builder manifest is
`sha256:b4046aa75595c3811ef95a7dfc2e9849f5088c8551895e5632786cae35ebe0ab`
with config
`sha256:b241a0560b661226481a88f52553a0fd3d1d4b5e966d8549a5de08b2704f3d85`.
Both builds produced a 19,728,440-byte `Image.lz4` with SHA-256
`647d9a007f3042342d73cb5cf951a2d1f987257e817583bf426036f46924c855`.

Two independent offline swaps into the verified stock partition image, plus a
third swap using the second kernel build, produced the same full 67,108,864-byte
partition SHA-256:
`10307cb975348f913bf4bdb024436d0f4b3c93c9cc1b8188ebf18960733cfcf6`.
The generated boot images were validation-only and are not distributable
artifacts.

This local agreement is reproducibility evidence, not publication, remote
attestation, or device qualification. No Phase C action touched a phone.
