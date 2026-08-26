import { DEFAULT_GATEWAY_URL, PACKAGE_NAME } from './context.mjs';

export function printHelp() {
  console.log(`WebMCP Browser Automation

Usage:
  webmcp mcp
  webmcp mcp --help
  webmcp gateway start
  webmcp gateway health [--json]
  webmcp health [--json]
  webmcp doctor [--json]
  webmcp bootstrap plan|apply|canary|vault-key-plan|binding-plan|tailnet-plan|tailnet-apply|profile-candidates|enroll-role|service-plan|service-apply|service-install-plan|service-install|service-load-plan|service-load|enroll-alias|enroll-binding [--json]
  webmcp launch [--name <name> | --profile-id <id>] [--gateway] [--relaunch] [--dry-run] [--json]
  webmcp close [--profile-id <id>] [--all] [--json]
  webmcp quit [--json]
  webmcp profiles list [--json]
  webmcp profile-pool acquire|renew|release|list|status|reclaim|doctor [--json]
  webmcp call <method> [jsonParams]
  webmcp ai <command> [options]
  webmcp vault <command> [options]
  webmcp workflow <command> [options]
  webmcp site <command> [options]
  webmcp automation <command> [options]
  webmcp project <command> [options]
  webmcp mobile mcp
  webmcp adb mcp                         Alias for webmcp mobile mcp
  webmcp captcha <command> [options]     Solve/detect CAPTCHAs (python solver)
  webmcp skills list [--json]
  webmcp skills path <name>
  webmcp skills doctor [--json]
  webmcp skills adopt [--provider <name> | --all] [--dry-run] [--yes]
  webmcp skills prune [--dry-run] [--yes]
  webmcp skills uninstall [--provider <name> | --all] [--dry-run] [--yes]
  webmcp store <command> [options]       Deprecated alias for webmcp site
  webmcp extension-info [--json]
  webmcp extension-path

MCP config example:
  {
    "mcpServers": {
      "webmcp": {
        "command": "npx",
        "args": ["-y", "${PACKAGE_NAME}", "mcp"]
      }
    }
  }

Environment:
  WEBMCP_GATEWAY_URL=${DEFAULT_GATEWAY_URL}
  WEBMCP_GATEWAY_HOST=127.0.0.1   Gateway bind host (set 0.0.0.0 to expose on LAN)
  WEBMCP_GATEWAY_TOKEN            Shared secret; required on POST /api when set
  WEBMCP_GATEWAY_AUTOSTART=1  Enable MCP dev-mode gateway autostart
  WEBMCP_PROFILE_ID           Route gateway calls to this connected Chrome profile
  WEBMCP_VAULT_KEY            Unlock local encrypted WebMCP vault commands
  WEBMCP_VAULT_KEY_FILE       Read the local vault key from a file
  WEBMCP_AI_BIN               Override standalone WebMCP AI CLI path or package name
  WEBMCP_WORKFLOW_DISPATCHER_BIN  Override workflow dispatcher bin path or package name
  WEBMCP_AUTOMATION_BIN           Override Automation Store CLI path or package name
  WEBMCP_RUNNER_BIN               Override Automation Runner CLI path or package name
  WEBMCP_ADB_MCP_BIN              Override ADB MCP server path or package name
  WEBMCP_KIT_MANIFEST             Override webmcp-kit.json inventory path
  WEBMCP_HOME                     Shared kit data dir (default: ~/.webmcp)
  WEBMCP_DATA_DIR                 Alias of WEBMCP_HOME (back-compat)
  WEBMCP_CHROME_BINARY            Override Chrome/Chromium binary path
`);
}

export function printMcpHelp() {
  console.log(`WebMCP stdio MCP adapter

Usage:
  webmcp mcp

The adapter is normally started by an MCP client from its registered config.
It exposes WebMCP gateway commands as mcp__webmcp__* tools and keeps browser
actions on the MCP transport. Start the gateway separately with:
  webmcp gateway start
`);
}

export function printBootstrapHelp() {
  console.log(`webmcp bootstrap — local WebMCP machine bootstrap

Usage:
  webmcp bootstrap plan [--json]
  webmcp bootstrap apply [--json]
  webmcp bootstrap canary [--json]
  webmcp bootstrap vault-key-plan [--json]
  webmcp bootstrap binding-plan [--json]
  webmcp bootstrap tailnet-plan [--json]
  webmcp bootstrap tailnet-apply [--yes] [--json]
  webmcp bootstrap profile-candidates [--json]
  webmcp bootstrap enroll-role --role <operator|runner-node|fleet-node> [--yes] [--json]
  webmcp bootstrap service-plan [--json]
  webmcp bootstrap service-apply [--json]
  webmcp bootstrap service-install-plan [--json]
  webmcp bootstrap service-install [--yes] [--json]
  webmcp bootstrap service-load-plan [--json]
  webmcp bootstrap service-load [--yes] [--json]
  webmcp bootstrap enroll-alias --gateway <id> --alias <id> (--candidate-ordinal <n>|--profile-id <id>) [--yes] [--json]
  webmcp bootstrap enroll-binding --id <id> --gateway <id> --profile-alias <id> --decision <approved|pending|rejected> [--reauth-policy <policy>] [--credential-purpose-ref <ref>] [--site-account-ref <ref>] [--download-policy <policy>] [--yes] [--json]

Notes:
  plan/canary/binding-plan/vault-key-plan/profile-candidates are read-only.
  enroll-* and service apply/install/load write only with --yes and redact local profile,
  Vault, account, Tailnet, and service path details from command output.`);
}

export function printProjectHelp() {
  console.log(`webmcp project — WebMCP project workspace management

Usage:
  webmcp project attach <dir> [--replace] [--as-copy <id>] [--repair-layout] [--default] [--dry-run] [--json]
  webmcp project attach --scan <root> [--replace] [--repair-layout] [--default] [--dry-run] [--json]
  webmcp project list [--json]
  webmcp project where [<id>] [--json]
  webmcp project doctor [<dir>] [--json]
  webmcp project new [--template <id>] [--at <dir>] [--id <id>] [--name <name>] [--default] [--dry-run] [--json]
  webmcp project init [--at <dir>] [--id <id>] [--name <name>] [--dir <storeDir>] [--force] [--dry-run] [--json]
  webmcp project init-store [--at <dir>] [--id <id>] [--name <name>] [--dir <storeDir>] [--force] [--dry-run] [--json]
  webmcp project build-index [--dir <projectStoreDir>] [--workspace <dir>] [--json]
  webmcp project export-pack --select <domain>/<id> --output <dir> [--alias <alias>] [--json]
  webmcp project content plan --at <dir> --json
  webmcp project content apply --at <dir> --yes --json
  webmcp project policy plan [--at <dir>] [--all] --json
  webmcp project policy apply [--at <dir>] [--all] --yes --json
  webmcp project charter adopt <relative-md> [--workspace <dir>] [--yes] [--json]
  webmcp project guide list [--json]
  webmcp project guide stage <collections/<id>/GUIDE.md> --as inputs/<path> --yes [--json]
  webmcp project schedule list [--workspace <path>] [--json]
  webmcp project schedule plan [<id>] --target <t> [--workspace <path>] [--json]
  webmcp project schedule apply [<id>] --target <t> [--workspace <path>] [--json]
  webmcp project schedule status [--all-targets] [--workspace <path>] [--json]

Notes:
  attach registers an existing project directory in the local workspace registry,
  or relocates its registered root after the folder was moved. Idempotent; without
  flags it never changes an existing registration.
  where prints the resolved project root; without an ID it resolves the registered
  default project.
  doctor runs the runner's workspace doctor, a registry audit of the project root,
  and an attach dry-run sanity check.
  new creates a project from a template in the Automation Store (template id =
  store automation id); without --template it bootstraps the store's default
  selection (all automations). Without --at the default parent is $WEBMCP_PROJECTS_ROOT
  or ~/WebMCP Projects.
  charter adopt is dry-run by default; pass --yes to write. It delegates the charter
  operation to the Automation Runner and never reads or modifies project files itself.
  policy plan is read-only. policy apply requires --yes, merges only WebMCP-owned
  sections, skips typed conflicts, and does not provide --force.
  guide list shows derived guides (collections/<id>/GUIDE.md). guide stage copies a
  reviewed guide below the intent/evidence boundary into inputs/; it requires the
  explicit --yes confirmation and never modifies or deletes the source.`);
}
