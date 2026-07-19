# shellink-cli skill

Agent Skill that teaches an AI coding agent to drive remote SSH and command
sessions through the local `shellink` CLI. See [`SKILL.md`](./SKILL.md) for the
skill body.

This skill lives at `skills/shellink-cli/` in the
[Shellink](https://github.com/jie123108/Shellink) repository. The folder name
must stay `shellink-cli` so it matches the `name` in the frontmatter.

## Prerequisite

The skill only wraps the CLI; it does not bundle it. A working `shellink`
executable must be on `PATH` (or invocable) for the agent that runs the skill.

On macOS/Linux, install the prebuilt binary:

```bash
curl -fsSL https://raw.githubusercontent.com/jie123108/Shellink/main/install.sh -o /tmp/shellink-install.sh
cat /tmp/shellink-install.sh
sh /tmp/shellink-install.sh
export PATH="$HOME/.local/bin:$PATH"
```

Windows is not supported by prebuilt binaries; build from source (see the
repository README). Then verify:

```bash
shellink -V
shellink server status --json
shellink agent-doc
```

Agents using this skill should run `command -v shellink` first and follow the
auto-install steps in [`SKILL.md`](./SKILL.md) when the CLI is missing.

## Install

**Recommended — the [`skills`](https://skills.sh/) CLI** (Node.js / `npx`).
The repo has more than one skill under `skills/`; always pass
`--skill shellink-cli` so only this subdirectory is installed.

```bash
# Current project (auto-detects your agent)
npx skills add jie123108/Shellink --skill shellink-cli

# Global (every project)
npx skills add jie123108/Shellink --skill shellink-cli -g

# List skills in the repo first
npx skills add jie123108/Shellink --list
```

Restart the agent (or start a new session) after installing so it re-scans
skills.

### Cursor

```bash
# Project
npx skills add jie123108/Shellink --skill shellink-cli --agent cursor

# Global
npx skills add jie123108/Shellink --skill shellink-cli --agent cursor -g

# Update
npx skills update shellink-cli -p -y
npx skills update shellink-cli -g -y
```

### Claude Code

```bash
# Project
npx skills add jie123108/Shellink --skill shellink-cli --agent claude-code

# Global
npx skills add jie123108/Shellink --skill shellink-cli --agent claude-code -g

# Update
npx skills update shellink-cli -p -y
npx skills update shellink-cli -g -y
```

### Codex

```bash
# Project
npx skills add jie123108/Shellink --skill shellink-cli --agent codex

# Global
npx skills add jie123108/Shellink --skill shellink-cli --agent codex -g

# Update
npx skills update shellink-cli -p -y
npx skills update shellink-cli -g -y
```

### Pi

```bash
# Project
npx skills add jie123108/Shellink --skill shellink-cli --agent pi

# Global
npx skills add jie123108/Shellink --skill shellink-cli --agent pi -g

# Update
npx skills update shellink-cli -p -y
npx skills update shellink-cli -g -y
```

### Trae

```bash
# Project
npx skills add jie123108/Shellink --skill shellink-cli --agent trae

# Global (international)
npx skills add jie123108/Shellink --skill shellink-cli --agent trae -g

# Global (China build)
npx skills add jie123108/Shellink --skill shellink-cli --agent trae-cn -g

# Update
npx skills update shellink-cli -p -y
npx skills update shellink-cli -g -y
```

### Antigravity

```bash
# Project
npx skills add jie123108/Shellink --skill shellink-cli --agent antigravity

# Global
npx skills add jie123108/Shellink --skill shellink-cli --agent antigravity -g

# Update
npx skills update shellink-cli -p -y
npx skills update shellink-cli -g -y
```

### OpenClaw

```bash
# Project
npx skills add jie123108/Shellink --skill shellink-cli --agent openclaw

# Global
npx skills add jie123108/Shellink --skill shellink-cli --agent openclaw -g

# Update
npx skills update shellink-cli -p -y
npx skills update shellink-cli -g -y
```

## Update

If you installed with the `skills` CLI, update from the terminal:

```bash
# Prompt for install scope
npx skills update shellink-cli

# Project-level
npx skills update shellink-cli -p -y

# Global
npx skills update shellink-cli -g -y
```

`upgrade` is an alias:

```bash
npx skills upgrade shellink-cli
```

You can also run `npx skills update` to update all installed skills. After
updating, restart the agent (or start a new session) so refreshed files load.

## Verify

After installing, start a new agent session and ask it to run
`shellink agent-doc`, or confirm the skill is listed in the agent's skill
index. If it is not discovered, check that the folder is named
`shellink-cli`, that `SKILL.md` is at its root, and restart the agent.
