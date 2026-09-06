# Public reproducibility fixture

Every file in this directory is intentionally public. `signing_key.pem`
contains a private key solely so independent builds can embed the same Linux
module-signing certificate and produce identical bytes. It is not secret, is
not a release trust root, and must never authenticate modules, releases,
devices, people, or services.

The build verifies the exact file hashes recorded in `kernel/builds.json`,
stages them with the recorded timestamp, and refuses if Kbuild changes the key
or certificate. The certificate uses a fixed serial and fixed validity window.

This fixture is acceptable only while all of these are true:

- `CONFIG_MODULE_SIG_FORCE` is disabled;
- module signature protection is disabled;
- `CONFIG_MODULE_SIG_PROTECT_LIST` is empty;
- a separately authorized live qualification proves there is no equivalent
  command-line, bootconfig, or runtime enforcement.

If any enforcement boundary exists, do not use this fixture or its kernel.
