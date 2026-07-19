export const AGENT_DOC = `# Shellink AI Agent CLI

Use the local \`shellink\` CLI as the stable automation interface. Do not implement the Unix socket or MessagePack protocol yourself.

All commands start the local daemon automatically. Add \`--json\` for stable machine-readable output.

## Workflow

    shellink profile list --query '<name, host, IP, or command keyword>' --json
    shellink session create --profile '<profile-id>' --json
    shellink session state '<session-id>' --json
    shellink session exec '<session-id>' --command 'uname -a' --json
    shellink session history '<session-id>' --since 0 --json
    shellink session input '<session-id>' --text 'yes' --json
    shellink session close '<session-id>' --json

States are CONNECTING, OUTPUTTING, WAITING_INPUT, IDLE, and DISCONNECTED. Wait for WAITING_INPUT before exec. For IDLE, inspect output and use input only when the program is clearly waiting for an answer. If a session is MANUAL, a human controls it; wait for AUTO rather than forcing input. Keep sessions open after completing a task so they can be reused. Close a session only when the user explicitly requests it.

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
    shellink session history '<session-id>' --since 0 --json
    shellink session input '<session-id>' --text 'yes' --json
    shellink session close '<session-id>' --json

## Files

    shellink session download '<id>' --path /remote/file --output ./file --json
    shellink session upload '<id>' --input ./file --path /remote/file --json
    shellink session edit '<id>' --input edits.json --json

\`edits.json\` contains the remote path and one or more exact replacements:

    {"path":"/remote/file","edits":[{"oldText":"exact text","newText":"replacement"}]}

Remote edit requires an AUTO session in WAITING_INPUT. Each \`oldText\` must be non-empty and match exactly once, including whitespace. Multiple edits must not overlap. Pass the same JSON with \`--input -\` to read it from stdin.

Exit codes: 0 success, 1 runtime/service error, 2 argument or validation error.
Credentials belong in JSON passed with \`--input FILE\` or \`--input -\`, never command-line arguments.
`

export const AGENT_DOC_JSON = {
  name: 'shellink',
  defaultMode: 'cli',
  output: { jsonFlag: '--json', exitCodes: { success: 0, runtimeError: 1, usageError: 2 } },
  states: ['CONNECTING', 'OUTPUTTING', 'WAITING_INPUT', 'IDLE', 'DISCONNECTED'],
  modes: ['AUTO', 'MANUAL'],
  profileConnectTypes: ['ssh', 'command'],
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
    session: ['list', 'create', 'state', 'history', 'input', 'exec', 'mode', 'close', 'remove-record', 'download', 'upload', 'edit'],
    webhook: ['list', 'create', 'delete'],
    server: ['start', 'status', 'stop', 'restart', 'logs', 'run'],
  },
}
