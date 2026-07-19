# Shellink — Install Guide for AI Agents

This document is written for an AI coding agent that has been asked to set up
Shellink for a user. Follow it directly; do not guess commands. It covers two
independent installs:

1. The `shellink` CLI itself (required to run any Shellink command).
2. The `shellink-cli` Agent Skill (optional, but recommended so you — the
   agent — know how to drive Shellink correctly).

Repository: <https://github.com/jie123108/Shellink>

## 1. Install the `shellink` CLI

Check first:

```bash
command -v shellink && shellink -V
```

If it is already installed and on `PATH`, skip to step 2.

### macOS / Linux

Prebuilt binaries exist for `darwin-arm64`, `darwin-x64`, `linux-arm64`, and
`linux-x64`. Download the installer, show it to the user, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/jie123108/Shellink/main/install.sh -o /tmp/shellink-install.sh
cat /tmp/shellink-install.sh
sh /tmp/shellink-install.sh
```

Pin a specific release tag instead of latest:

```bash
sh /tmp/shellink-install.sh --version v0.1.0
```

For a system-wide install (when the user wants `/usr/local/bin` or the
default dir is not writable), run with `sudo`:

```bash
sudo sh /tmp/shellink-install.sh --dir /usr/local/bin
```

The script:

- Detects OS/arch via `uname` and picks the matching release asset.
- Downloads the binary and `SHA256SUMS.txt` from GitHub Releases and verifies
  the checksum.
- Installs it as `$HOME/.local/bin/shellink` (override with `--dir DIR` or
  `SHELLINK_INSTALL_DIR`).
- If the install directory is not on `PATH`, appends an `export PATH=...`
  line to the user's shell profile (`~/.zshrc`, `~/.bashrc`, etc.).
- Refuses to run on Windows and prints the source-build instructions instead.

After it finishes, verify in a new shell (or after exporting `PATH`):

```bash
shellink -V
```

### Windows

No prebuilt binary is published. Tell the user Windows requires building from
source (Node.js 22.19+, npm):

```bash
git clone https://github.com/jie123108/Shellink.git
cd Shellink
npm install
npm run build
# CLI: ./node_modules/.bin/shellink
```

### Verify

```bash
shellink -V
shellink server status --json
```

The first command starts the user-level daemon automatically if it is not
already running.

## 2. Install the `shellink-cli` Agent Skill

This is optional, but install it whenever you (the agent) will operate
Shellink sessions or profiles for the user — it gives you the correct
CLI-first workflow and points you at `shellink agent-doc` for the full command
reference.

Use the [`skills`](https://skills.sh/) CLI via `npx`. The Shellink repository
has more than one skill under `skills/`, so always pass
`--skill shellink-cli` to install only this one:

```bash
# Project-level, auto-detect this agent
npx skills add jie123108/Shellink --skill shellink-cli

# Global (user-level), auto-detect this agent
npx skills add jie123108/Shellink --skill shellink-cli -g

# Or force a specific agent target, e.g.:
npx skills add jie123108/Shellink --skill shellink-cli --agent cursor
npx skills add jie123108/Shellink --skill shellink-cli --agent claude-code
npx skills add jie123108/Shellink --skill shellink-cli --agent codex
npx skills add jie123108/Shellink --skill shellink-cli --agent pi
```

To update an existing install:

```bash
npx skills update shellink-cli
```

No prior submission to skills.sh is required — `npx skills` reads directly
from the GitHub repository above.

After installing, restart the current agent session (or start a new one) so
the skill is re-scanned, then confirm it loaded by running:

```bash
shellink agent-doc
```

## Summary for the agent

- If `shellink` is missing: run the installer in step 1, then verify with
  `shellink -V`.
- If this is a Shellink-driving task and the skill is not already installed:
  run the `npx skills add` command in step 2 for the detected agent.
- Never implement the Unix socket protocol directly — always call `shellink`.
- Read `shellink agent-doc` before operating sessions or profiles.
