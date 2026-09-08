# eip-pixel11xl-forge

Run Forge v4 and Docker Engine natively on a Pixel 11 Pro XL.

This repository owns the Pixel host, installer, Forge Control Android app,
and release packaging. Forge itself remains in
[`eip-cve-public-v4`](https://github.com/exploitintel/eip-cve-public-v4) and
is pinned here by [`FORGE_REVISION`](FORGE_REVISION).

## Supported phone

| Device | Google build | KernelSU-Next | Network |
| --- | --- | --- | --- |
| Pixel 11 Pro XL (`kodiak`) | `CD1A.260714.001.A9` | 3.3.0, LKM | Wi-Fi |

Other phones and Android builds are not supported by this release.

## Install

You need an unlocked bootloader, a USB cable, and a computer with `adb`,
`fastboot`, `curl`, and `unzip`. The clean-install path erases the phone.

### 1. Download two files

Download the latest installer bundle from this repository's
[Releases](https://github.com/exploitintel/eip-pixel11xl-forge/releases) page
and extract it.

Then open Google's official
[Pixel factory-image page](https://developers.google.com/android/images),
accept Google's terms, and download the factory ZIP for:

```text
Pixel 11 Pro XL (kodiak)
CD1A.260714.001.A9
```

Keep the Google ZIP intact. You do not need to find or rename partition
images yourself.

### 2. Prepare the Google firmware inputs

With the phone booted, USB debugging enabled, and this computer authorized:

```sh
./prepare-firmware.sh \
  --factory-zip ~/Downloads/kodiak-cd1a.260714.001.a9-factory-*.zip \
  --serial ADB_SERIAL
```

The command extracts `boot.img` and `init_boot.img`, verifies that both belong
to the supported Google build, downloads the exact pinned Docker and
KernelSU-Next inputs, and creates the local KernelSU bootstrap image. Google
firmware never enters this repository or its release assets.

### 3. Wipe the phone

Back up anything you need first. This command erases Android user data:

```sh
./install.sh --serial ADB_SERIAL --wipe
```

### 4. Finish Android setup and install Forge

Complete Android setup, connect to Wi-Fi, enable USB debugging, and authorize
the computer again. Then run:

```sh
./install.sh --serial ADB_SERIAL
```

To install provider keys at the same time:

```sh
./install.sh \
  --serial ADB_SERIAL \
  --provider-env /path/to/providers.env
```

The provider file is ordinary `NAME=value` lines and stays outside the
repository. For example:

```text
OLLAMA_API_KEY=replace-me
OPENAI_API_KEY=replace-me
ANTHROPIC_API_KEY=replace-me
DEEPSEEK_API_KEY=replace-me
GLM_API_KEY=replace-me
OPENROUTER_API_KEY=replace-me
```

Installation is complete only when the final line is:

```text
READY
```

Open the Forge Control app on the phone, then tap **Open Forge WebUI**.

## What gets installed

- the matched Pixel kernel and native Docker host;
- the controller image built from the pinned public Forge commit;
- the Pixel operator image and phone operations;
- Forge Control for starting, parking, and inspecting the system; and
- the Forge WebUI and agent-chat service.

New installations default Ollama to `https://ollama.com`; no local Ollama
binary is installed. Local Ollama and every other Forge provider remain
available through normal Forge configuration.

The first release supports container networking over Wi-Fi. Cellular
networking remains outside the current qualification because of the known
provider-side issue.

## Source layout

- `deployment/` contains the complete installer and package builder.
- `eip/` contains Pixel-specific Forge and container glue.
- `android-app/` contains Forge Control.
- `module/`, `android/`, and `tools/` contain the native Pixel Docker host.
- `kernel/` contains the kernel recipe, patches, configuration, and source
  identity needed for the distributed kernel.

Run the source checks with:

```sh
npm test
bash tools/check-public-tree.sh
```

Pull requests and pushes to `main` run those checks plus the Android app host
contract tests. Kernel and module candidate builds remain manual workflows.

Detailed host and recovery documentation remains under [`docs/`](docs/).

## Important limits

- The installer writes the active `boot` and `init_boot` partitions.
- Never use firmware from a different device or build.
- Keep the matching factory image available for fastboot recovery.
- Unlocking the bootloader and installing a custom kernel weaken the stock
  Android security model.

First-party source is MIT licensed. Kernel materials retain their upstream
licenses. See [`NOTICE.md`](NOTICE.md).
