# Changelog

All notable changes to Shellink are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

When preparing a release:

1. Move items from `[Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section.
2. Commit the changelog update.
3. Create and push a matching tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The GitHub Release body is generated from the matching section in this file
(see `.github/workflows/release.yml`).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.2.3] - 2026-08-02

### Changed

- Hide PTY transfer/edit protocol noise from history and live terminals (one-line summary; use `--include-internal` to debug).

### Fixed

- Web UI: append the filename when uploading to a directory path (`…/`).
- Clear post-transfer input junk and stop forwarding xterm OSC replies, so MANUAL Enter no longer runs stray `11` / `rgb:…` commands.
- CLI TUI: recognize kitty CSI-u / modifyOtherKeys encodings for shortcuts (Ctrl+], Ctrl+\, search, navigation) so they work outside legacy terminals.
- Web UI: fix Manual Control switch contrast and stop clipping the last terminal row.

## [0.2.2] - 2026-07-29

### Fixed

- Fix Bun PTY uploads (especially ~10KB+) that still hung in bash PS2 after 0.2.1: a single staged write of several `printf` lines (~2KB) overflowed the kernel tty input queue (`TTYHOG` ≈ 1024 bytes), which silently dropped mid-line bytes and left an unbalanced quote. Staging now sends **one line at a time** with an in-line ack marker, keeps each write under the queue limit, and only sends the next chunk after the previous ack is observed.
- Fix transfer/edit status markers becoming undetectable after `stty -echo`: without local echo, shell prompts have no trailing newline, so markers could glue onto `$ $ $ ...` and miss line-anchored matching. Marker emitters (`echoProofEcho`, `SP_SZ` / `SP_UP` / `SP_DEC` / `SP_EDIT`) now print a leading newline via `printf`.
- Harden the transfer path around the remaining failure modes: wait for drain under Bun stdin backpressure, batch session history writes (flush before history reads), abort in-flight transfers on cancel, verify staged encoded size before decode (retry once with a smaller chunk), and recover with Ctrl+C / restore echo / temp cleanup before surfacing upload errors.
- Apply the same one-line-with-ack pacing to remote-edit staging so large edit payloads cannot overflow the tty queue either.

## [0.2.1] - 2026-07-28

### Fixed

- Fix file upload/edit hangs when bash PS2 (`>`) was mistaken for the shell prompt; uploads/edits now write encoded payloads via `printf` appends (no heredocs) and arm `waitForStable` before the decode/verify command. Also stop mapping "remote file size" verify errors to HTTP 413.
- Fix Bun-compiled uploads failing on narrow (80-col) PTYs where long `printf`/probe lines were wrap-corrupted: widen via remote `stty cols`, keep `printf` chunks short, and probe codecs with multi-line commands.
- Fix large Bun uploads that lost data or raced `waitForStable` during the printf storm: pace writes with sync markers, drain before finalize, wait for `SP_UP` in history (not intermediate prompts), and settle to `WAITING_INPUT` before releasing the transfer lock.
- Widen Bun-compiled command/expect PTYs to 2000 cols by default so long `exec` commands and transfers are not wrap-truncated on narrow terminals.

## [0.2.0] - 2026-07-26

### Added

- **Non-blocking session jobs:** Long-running `exec` / `edit` / transfer work can detach from the foreground RPC, with job status polling, cancel, and stderr heartbeats so agent hosts with short request windows (e.g. ~30s) do not time out mid-operation. Documented in agent-doc and CLI help.
- **`shellink upgrade`:** Self-upgrade from GitHub Releases with download progress, daemon stop/restart handling, `--check` / `--version` / `--yes`, and machine-readable `--json` output.
- **Install PATH setup:** `install.sh` appends the install directory to the user shell profile when it is missing from `PATH`, with guidance for system-wide (sudo) installs.
- **Build commit in version output:** Binaries embed a short git commit (`GIT_COMMIT`). Shown by `shellink version` and `shellink server status` / `restart` / `start` (and `system.hello` as `serviceCommit`).

### Changed

- Lower default timeouts for foreground `exec` / `edit` so typical agent calls finish inside short host windows; use detach jobs for longer work.
- Raise SSH `keepaliveCountMax` so long PTY transfers are less likely to be dropped around ~45s of idle-looking traffic.
- Clarify in docs that Shellink does not implement a host's automatic login flow; use `expect`, `sshpass`, or `ProxyJump` for those cases.

### Fixed

- Correct edit-operation timeout inversion that could cut edits short or wait incorrectly.
- Slow uploads no longer treat session `IDLE` as decode completion; verification uses the remaining transfer timeout budget.

### Downloads

Standalone binaries for:

- `shellink-darwin-arm64` (macOS Apple Silicon)
- `shellink-darwin-x64` (macOS Intel)
- `shellink-linux-arm64`
- `shellink-linux-x64`

Verify downloads with `SHA256SUMS.txt`.

Full documentation: [README.md](https://github.com/jie123108/Shellink/blob/v0.2.0/README.md) · [中文文档](https://github.com/jie123108/Shellink/blob/v0.2.0/README.zh-CN.md)

## [0.1.0] - 2026-07-19

First public release of Shellink — an open-source session middleware for AI
agents and humans working with SSH and local terminal sessions. It provides one
stable CLI for connection profiles, interactive sessions, command execution,
file transfer, remote editing, and session state. A local daemon owns the
sessions and exposes a browser-friendly Web UI plus HTTP and WebSocket
compatibility APIs.

### Features

- **SSH and custom command sessions:** Connect directly with SSH, or run a command/script inside a PTY.
- **Multi-hop login automation:** `connectType: "command"` supports `expect` and similar scripts for multi-level bastion hosts, jump-host menus, OTP prompts, and legacy authentication flows.
- **Command execution and state handling:** Execute commands, inspect state, provide interactive input, and wait for the session to become ready before the next operation.
- **File transfer across jump hosts:** Upload and download files through the existing PTY instead of requiring SFTP. This keeps transfers working through custom command chains and multi-hop connections.
- **Remote file editing:** Apply precise replacements with `shellink session edit`.
- **Audit history and supervision:** Session input/output is retained as history for audit and replay, while `MANUAL` mode lets a human take control and supervise or answer prompts.
- **CLI/TUI, Web UI, REST, and WebSocket:** Use the interface that fits the workflow, with stable `--json` output for automation.
- **Encrypted profiles and optional single-file binaries:** Credentials are protected in SQLite, and Bun builds are available for macOS and Linux.

### Why Shellink Is Designed for AI Agents

Shellink is designed around the situations where an AI agent needs reliable access but should not guess or bypass human controls:

- **Scriptable multi-hop access:** Agents can reuse `expect` or other custom login scripts for several bastion hops instead of implementing each site's authentication flow themselves.
- **PTY-based continuity:** Commands and file transfers use the same PTY path, so an agent can work through jump hosts even when no direct SFTP or SSH endpoint is available.
- **Human supervision:** `AUTO` mode is for agent actions; `MANUAL` mode hands the terminal to a person for approval, OTP entry, or intervention before automation continues.
- **Auditable operations:** Session input/output history and daemon logs give operators a record for reviewing what the agent saw and did.
- **Observable progress:** Explicit session states and machine-readable CLI output let an agent decide whether to execute, send input, wait, or ask for human help.

### Downloads

This release includes standalone binaries for:

- `shellink-darwin-arm64` (macOS Apple Silicon)
- `shellink-darwin-x64` (macOS Intel)
- `shellink-linux-arm64`
- `shellink-linux-x64`

Verify downloads with `SHA256SUMS.txt`.

> **Security warning:** `command` profiles execute their configured command as the server process user. Run Shellink only in a trusted environment and protect `SHELLINK_TOKEN`. Prefer read-only or non-production targets for AI agents.

Full documentation: [README.md](https://github.com/jie123108/Shellink/blob/v0.1.0/README.md) · [中文文档](https://github.com/jie123108/Shellink/blob/v0.1.0/README.zh-CN.md)
