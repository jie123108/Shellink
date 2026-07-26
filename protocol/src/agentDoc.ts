export const AGENT_DOC = `# Shellink AI Agent CLI

Use the local \`shellink\` CLI as the stable automation interface. Do not implement the Unix socket or MessagePack protocol yourself.

All commands start the local daemon automatically. Add \`--json\` for stable machine-readable output.

## Workflow

    shellink profile list --query '<name, host, IP, or command keyword>' --json
    shellink session create --profile '<profile-id>' --json
    shellink session state '<session-id>' --json
    shellink session exec '<session-id>' --command 'uname -a' --json
    shellink session exec '<session-id>' --command 'long-build' --detach --json
    shellink session exec-status '<job-id>' --since <cursor> --wait 20000 --json
    shellink session exec-cancel '<job-id>' --json
    shellink session history '<session-id>' --since 0 --json
    shellink session input '<session-id>' --text 'yes' --json
    shellink session close '<session-id>' --json

States are CONNECTING, OUTPUTTING, WAITING_INPUT, IDLE, and DISCONNECTED. Wait for WAITING_INPUT before exec. For IDLE, inspect output and use input only when the program is clearly waiting for an answer. If a session is MANUAL, a human controls it; wait for AUTO rather than forcing input. Keep sessions open after completing a task so they can be reused. Close a session only when the user explicitly requests it.

## Long-running operations

Host agents (e.g. Cursor) typically wait only ~30s for a shell command before backgrounding it and stopping. To avoid "succeeded but the agent stopped" situations, keep every CLI call short:

- Default timeouts are tuned to fit the 30s window: exec 20s, edit 25s, transfer 120s. The CLI socket timeout is the server timeout + 1s. For anything slower, use \`--detach\`.
- \`session exec --detach\` starts the command and returns a \`jobId\` immediately. Poll with \`session exec-status <job-id> --since <cursor> --wait 20000\`. The response includes \`job.status\` (RUNNING|DONE|TIMED_OUT|CANCELED|DISCONNECTED|FAILED), incremental \`output\`, and a \`cursor\` for the next call. Repeat until \`done\` is true.
- \`session exec-status\` long-polls up to \`--wait\` ms, so each call stays well under the 30s window while still making progress.
- \`upload\`, \`download\`, and \`edit\` also accept \`--detach\`; poll their resulting jobs with \`session exec-status\`.
- \`download --detach --output /local/path\` has the daemon write the file to \`/local/path\`; the job result \`output\` field confirms the path.
- On a 409 "session is running a ..." conflict, the message names the running job. Poll \`session exec-status <job-id>\` or cancel with \`session exec-cancel <job-id>\` (sends Ctrl+C) instead of retrying blindly.
- For very long remote tasks, prefer \`nohup cmd > /tmp/x.log 2>&1 &\` (detached), then poll the log with \`session exec --command 'tail -n 50 /tmp/x.log'\`.
- If \`exec\` returns \`timedOut: true\`, the remote command is still running and the session lock is held. Poll \`exec-status\` with the returned \`jobId\` and \`cursor\`, or cancel the job.
- If a command returns \`METHOD_NOT_FOUND\`, the local daemon is older than the CLI; run \`shellink server restart\`.

## Profiles

Search Profiles with a keyword before creating a session. Do not list every Profile. The keyword is matched case-insensitively against the Profile name, SSH host/IP, and command:

    shellink profile list --query '<keyword>' --json
    shellink profile get '<profile-id>' --json

Create or update Profiles with \`--input FILE\` or \`--input -\`. Credentials must never be passed in argv. Profile JSON uses \`connectType: "ssh"\` or \`connectType: "command"\` and supports terminal dimensions and \`promptRegex\`.

    shellink profile create --input - --json
    shellink profile update '<profile-id>' --input profile.json --json

## Sessions

    shellink session list --json
    shellink session create --profile '<profile-id>' --json
    shellink session state '<session-id>' --json
    shellink session exec '<session-id>' --command 'uname -a' --json
    shellink session exec '<session-id>' --command 'long-build' --detach --json
    shellink session exec-status '<job-id>' --since <cursor> --wait 20000 --json
    shellink session exec-cancel '<job-id>' --json
    shellink session history '<session-id>' --since 0 --json
    shellink session input '<session-id>' --text 'yes' --json
    shellink session close '<session-id>' --json

## Files

    shellink session download '<id>' --path /remote/file --output ./file --json
    shellink session upload '<id>' --input ./file --path /remote/file --json
    shellink session edit '<id>' --input edits.json --json

For large or slow transfers, append \`--detach\` and poll the returned job:

    shellink session upload '<id>' --input ./file --path /remote/file --detach --json
    shellink session download '<id>' --path /remote/file --output ./file --detach --json
    shellink session exec-status '<job-id>' --since <cursor> --wait 20000 --json

\`edits.json\` contains the remote path and one or more exact replacements:

    {"path":"/remote/file","edits":[{"oldText":"exact text","newText":"replacement"}]}

Remote edit requires an AUTO session in WAITING_INPUT. Each \`oldText\` must be non-empty and match exactly once, including whitespace. Multiple edits must not overlap. Pass the same JSON with \`--input -\` to read it from stdin.

## Upgrade

Upgrade the standalone binary from GitHub Releases (use \`--yes\` when non-interactive):

    shellink upgrade --check --json
    shellink upgrade --yes --json
    shellink upgrade --version v0.2.0 --yes --json

Exit codes: 0 success, 1 runtime/service error, 2 argument or validation error.
Credentials belong in JSON passed with \`--input FILE\` or \`--input -\`, never command-line arguments.
`

export const AGENT_DOC_JSON = {
  name: 'shellink',
  defaultMode: 'cli',
  output: { jsonFlag: '--json', exitCodes: { success: 0, runtimeError: 1, usageError: 2 } },
  states: ['CONNECTING', 'OUTPUTTING', 'WAITING_INPUT', 'IDLE', 'DISCONNECTED'],
  modes: ['AUTO', 'MANUAL'],
  jobStatuses: ['RUNNING', 'DONE', 'TIMED_OUT', 'CANCELED', 'DISCONNECTED', 'FAILED'],
  profileConnectTypes: ['ssh', 'command'],
  defaults: { execTimeoutMs: 20_000, editTimeoutMs: 25_000, transferTimeoutMs: 120_000 },
  longRunning: {
    preferDetachAboveMs: 25_000,
    flow: [
      "shellink session exec '<id>' --command '...' --detach --json",
      "shellink session exec-status '<job-id>' --since <cursor> --wait 20000 --json",
      "shellink session exec-cancel '<job-id>' --json",
    ],
    onConflict409: 'poll exec-status for the named job, or exec-cancel',
    onMethodNotFound: 'shellink server restart',
  },
  remoteEdit: {
    command: 'shellink session edit ID --input <FILE|-> --json',
    input: {
      path: 'non-empty remote file path',
      edits: [{ oldText: 'non-empty exact text, unique in the file', newText: 'replacement text' }],
    },
    requirements: { mode: 'AUTO', state: 'WAITING_INPUT', editsMustNotOverlap: true },
  },
  commands: {
    profile: ['list', 'get', 'create', 'update', 'delete'],
    session: ['list', 'create', 'state', 'history', 'input', 'exec', 'exec-status', 'exec-cancel', 'mode', 'close', 'remove-record', 'download', 'upload', 'edit'],
    webhook: ['list', 'create', 'delete'],
    server: ['start', 'status', 'stop', 'restart', 'logs', 'run'],
    upgrade: ['--check', '--version', '--yes'],
  },
}
