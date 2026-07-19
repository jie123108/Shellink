---
name: shellink-iterm2-import
description: >-
  Scan and import local macOS iTerm2 Profiles into Shellink through the normal
  profile API. Use when a user asks to migrate iTerm2 connections, Custom
  Commands, SSH profiles, or DynamicProfiles into Shellink.
---

# Shellink iTerm2 Import

This skill runs on the Mac that owns the iTerm2 configuration. It reads the
standard iTerm2 plist and DynamicProfiles directory, converts `ssh` commands to
SSH profiles, keeps other Custom Commands as command profiles, and sends
profiles through `shellink profile create --input -` or
`shellink profile update <id> --input -`.

The server does not need an iTerm2-specific endpoint. Shellink encrypts any
private key sent in the profile request; the scanner never prints private key
contents.

## Requirements

- macOS with iTerm2 configuration files present.
- Python 3.9 or newer.
- A built and available `shellink` executable on PATH.

## Workflow

Run the helper from the repository root:

```bash
python3 skills/shellink-iterm2-import/scripts/import_iterm2.py --json
```

Inspect the candidates, then import by Guid or exact name:

```bash
python3 skills/shellink-iterm2-import/scripts/import_iterm2.py --guid <guid>
python3 skills/shellink-iterm2-import/scripts/import_iterm2.py --name "Production"
```

Use `--all` only after reviewing the scan. Re-importing the same source is
matched first by Shellink `uniqueId` (set to the iTerm2 `Guid`), then by exact
`name` when `uniqueId` is missing (legacy imports). By default a matching
profile is updated in place instead of creating a duplicate, so renaming the
iTerm2 profile still updates the same Shellink row and refreshes its `name`.
Name-matched legacy rows are backfilled with the Guid on update. Control this
with `--on-existing`:

- `update` (default): overwrite the matching profile (by uniqueId, else name).
- `skip`: leave the matching profile untouched.
- `create`: always create a new profile, allowing duplicates.

Use `--dry-run` to verify selection without contacting the server.

For SSH commands without an explicit `-i`, the helper checks `ssh -G` output
and standard `~/.ssh` identities. iTerm2 passwords are not exported by this
skill; profiles without a readable private key are imported as password-auth
profiles so the password can be added later in the Shellink Web console.
