# Notices and attribution

The first-party scripts, tools, tests, documentation, and Android runtime
helpers are provided under the repository MIT license unless a file says
otherwise.

The kernel configuration and patches apply to Linux kernel source. Each patch
states the license of the upstream file it modifies. Linux kernel source and
resulting distributions remain subject to the upstream licensing terms and
applicable per-file SPDX identifiers. Copies of the upstream licensing texts
are preserved at `kernel/COPYING` and `kernel/LICENSES/`.

This project downloads the pinned Docker Engine 29.8.0 AArch64 static archive
from Docker's official distribution site and applies reviewed, same-length path
substitutions on the user's machine. It does not distribute its binaries. The
archive identities recorded in `tools/engine.json` include:

- Moby 29.8.0, commit `3ce5872b7950c63ba2ffbc5123101019ff3e6682`,
  Apache-2.0;
- Docker CLI 29.8.0, commit
  `88096ef00576baf72a9cb45caa45c0544c40e0a7`, Apache-2.0;
- containerd 2.3.4, commit
  `db8809540e1a7a9da5d518876894933ff55692ab`, Apache-2.0;
- runc 1.5.1, commit `8f2685a471d3347a686ad3909783d8aafc6bb208`,
  Apache-2.0;
- Tini 0.19.0, commit `de40ad007797e0dcd8b7126f27bb87401d224240`,
  MIT.

Upstream license and notice texts are available from [Moby](https://github.com/moby/moby),
[Docker CLI](https://github.com/docker/cli),
[containerd](https://github.com/containerd/containerd),
[runc](https://github.com/opencontainers/runc), and
[Tini](https://github.com/krallin/tini).

Docker and the Docker logo are trademarks of Docker, Inc. This project is not
affiliated with, sponsored by, or endorsed by Docker, Inc.

KernelSU-Next is a separate project used by the installation design. This
repository is not affiliated with KernelSU-Next. Optional future AMD64 support
may use QEMU through a separately pinned binfmt image; QEMU is GPL-2.0 licensed
and is not distributed here.

Development module tools are cross-compiled with the exact Bootlin
AArch64-musl toolchain recorded in `tools/aarch64-musl-toolchain.json`. The
toolchain archive itself is not distributed. The applicable musl 1.2.5
copyright and permission notice is preserved at
`tools/licenses/musl-COPYRIGHT` and inside each qualification module ZIP.

Google Pixel, Android, and related marks belong to Google LLC. Google firmware
and boot images are not included. Users must obtain their own matching factory
image under Google's terms.
