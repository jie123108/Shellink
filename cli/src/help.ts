import type { CliLocale } from './i18n.js'

const help = {
  'zh-CN': {
    root: `Shellink {version}

用法:
  shellink                         输出帮助
  shellink cli                     进入交互式 TUI（自动启动 daemon）
  shellink <命令> [选项]

命令:
  cli          进入交互式 TUI
  server       管理后台 daemon
  profile      管理连接配置
  session      管理终端会话
  webhook      管理状态回调
  agent-doc    输出 AI Agent 使用文档
  version      输出版本信息
  help         输出帮助

全局选项:
  --json       输出单行 JSON
  -h, --help   输出当前命令帮助
  -V, --version 输出版本信息

运行 shellink <命令> --help 查看详细帮助。`,
    server: `用法: shellink server <start|status|stop|restart|logs|run> [选项]

命令:
  start                 后台启动 daemon
  status                查询 daemon 状态
  stop                  停止 daemon
  restart               重启 daemon
  logs [--lines N]      显示日志末尾，默认 40 行
  run                   前台运行 daemon`,
    profile: `用法: shellink profile <命令> [选项]

命令:
  list [--query TEXT]                         列出或搜索配置
  get <profile-id>                            获取配置
  create --input <FILE|->                     创建配置
  update <profile-id> --input <FILE|->        更新配置
  delete <profile-id>                         删除配置

凭证应通过 --input 文件或 stdin 传入，不要放在命令行参数中。`,
    session: `用法: shellink session <命令> [选项]

命令:
  list                                              列出会话
  create --profile ID [--cols N] [--rows N]         使用配置创建会话
  state <session-id>                                查询会话状态
  history <session-id> [--since CURSOR] [--limit N] 读取会话历史
  input <session-id> --text TEXT [--no-newline]     写入文本
  exec <session-id> --command COMMAND [--timeout MS] 执行命令
  mode <session-id> --mode <AUTO|MANUAL>             设置输入模式
  close <session-id>                                 关闭会话
  remove-record <session-id>                         删除会话记录
  download <session-id> --path REMOTE --output LOCAL [--timeout MS] 下载远端文件
  upload <session-id> --input LOCAL --path REMOTE [--sha256 HASH] [--timeout MS] 上传本地文件
  edit <session-id> --input <FILE|-> [--timeout MS]  编辑远端文件`,
    webhook: `用法: shellink webhook <命令> [选项]

命令:
  list
  create --input <FILE|->
  delete <webhook-id>`,
    'agent-doc': `用法: shellink agent-doc [--json]

默认输出 Markdown；--json 输出结构化命令和状态参考。`,
  },
  'en-US': {
    root: `Shellink {version}

Usage:
  shellink                         Print help
  shellink cli                     Start the interactive TUI (starts the daemon automatically)
  shellink <command> [options]

Commands:
  cli          Start the interactive TUI
  server       Manage the background daemon
  profile      Manage connection profiles
  session      Manage terminal sessions
  webhook      Manage status callbacks
  agent-doc    Print AI agent documentation
  version      Print version information
  help         Print help

Global options:
  --json       Print single-line JSON
  -h, --help   Print help for the current command
  -V, --version Print version information

Run shellink <command> --help for detailed help.`,
    server: `Usage: shellink server <start|status|stop|restart|logs|run> [options]

Commands:
  start                 Start the daemon in the background
  status                Show daemon status
  stop                  Stop the daemon
  restart               Restart the daemon
  logs [--lines N]      Show the end of the log (40 lines by default)
  run                   Run the daemon in the foreground`,
    profile: `Usage: shellink profile <command> [options]

Commands:
  list [--query TEXT]                         List or search profiles
  get <profile-id>                            Get a profile
  create --input <FILE|->                     Create a profile
  update <profile-id> --input <FILE|->        Update a profile
  delete <profile-id>                         Delete a profile

Pass credentials through an --input file or stdin, never command-line arguments.`,
    session: `Usage: shellink session <command> [options]

Commands:
  list                                              List sessions
  create --profile ID [--cols N] [--rows N]         Create a session from a profile
  state <session-id>                                Show session state
  history <session-id> [--since CURSOR] [--limit N] Read session history
  input <session-id> --text TEXT [--no-newline]     Write text
  exec <session-id> --command COMMAND [--timeout MS] Run a command
  mode <session-id> --mode <AUTO|MANUAL>             Set input mode
  close <session-id>                                 Close a session
  remove-record <session-id>                         Delete a session record
  download <session-id> --path REMOTE --output LOCAL [--timeout MS] Download a remote file
  upload <session-id> --input LOCAL --path REMOTE [--sha256 HASH] [--timeout MS] Upload a local file
  edit <session-id> --input <FILE|-> [--timeout MS]  Edit a remote file`,
    webhook: `Usage: shellink webhook <command> [options]

Commands:
  list
  create --input <FILE|->
  delete <webhook-id>`,
    'agent-doc': `Usage: shellink agent-doc [--json]

Prints Markdown by default; --json prints structured command and status references.`,
  },
} as const

export function formatHelp(topic: string, locale: CliLocale, version: string): string {
  const text = help[locale][topic as keyof typeof help['en-US']] ?? help[locale].root
  return text.replace('{version}', version)
}
