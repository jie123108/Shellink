---
name: shellink-cli
description: >-
  Use the local Shellink CLI to create and operate SSH or command sessions.
  Use for remote commands, interactive terminals, file transfer, and profiles.
  Requires the local `shellink` CLI on PATH; auto-install if missing.
---

# Shellink CLI

This skill depends on the local `shellink` command. Do not implement or connect
to the Unix socket protocol directly.

## Prerequisite: install `shellink` if missing

Before any Shellink operation, ensure `shellink` is available:

```bash
command -v shellink
```

If it is missing:

1. **macOS / Linux** — install the prebuilt binary (latest release):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/jie123108/Shellink/main/install.sh -o /tmp/shellink-install.sh
   cat /tmp/shellink-install.sh
   sh /tmp/shellink-install.sh
   ```

   Pin a version if needed:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/jie123108/Shellink/main/install.sh -o /tmp/shellink-install.sh
   cat /tmp/shellink-install.sh
   sh /tmp/shellink-install.sh --version v0.1.0
   ```

   The installer places `shellink` in `$HOME/.local/bin`. If that directory is
   not on `PATH`, add it for the current session (and tell the user to persist
   it in their shell profile):

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   ```

2. **Windows** — prebuilt binaries are not published. Tell the user to build
   from source (Node.js 22.19+, npm):

   ```bash
   git clone https://github.com/jie123108/Shellink.git
   cd Shellink
   npm install
   npm run build
   # CLI: ./node_modules/.bin/shellink
   ```

After install, verify:

```bash
shellink -V
shellink server status --json
```

## Operate sessions

Always read the installed command reference before operating sessions or
profiles, and follow it. Re-read it rather than relying on memorized commands:

```bash
shellink agent-doc
```

Add `--json` for stable machine-readable output. A command starts the user
daemon automatically.
