> 🚧 **Pre-release: Active development.**
> cicd-sensor-action is currently in pre-release and under active development. Feedback is very welcome.

# cicd-sensor-action

GitHub Action for running [cicd-sensor](https://github.com/cicd-sensor/cicd-sensor) on a Linux GitHub Actions runner.

Published as `cicd-sensor/cicd-sensor-action`. See the [GitHub-hosted runner guide](https://cicd-sensor.github.io/user-guide/github-hosted.html) for usage.

## Placement and shutdown

Place this action as the **first step**, before checkout and other actions. Its
`pre` registers cleanup early so its `post` runs after cleanup registered by later
actions, including actions with their own `pre` steps.

After reports and artifacts are processed, the action sends SIGTERM to the Agent
it started and waits up to 30 seconds for it to exit. This lets the Agent finalize
the job and send its Summary before runners such as Blacksmith tear down the VM.
Cleanup is also attempted if setup or report generation fails. An existing Agent
reused through its socket is never stopped.

Monitoring ends during this action's post step; later runner/provider cleanup is
outside that window. Forced cancellation or VM loss can still interrupt delivery.
Agent exit confirms process termination, not Manager receipt: current Agent
versions can log delivery errors without returning a failing exit status.

## Config and Rules

Project-local config and rules live under `.cicd-sensor/`:

```text
repo
└── .cicd-sensor/
    ├── config.yaml
    └── rules/
        ├── a.yaml
        └── b.yaml
```

Use one or more YAML files under `rules/`.

Use `config.yaml` for project-local settings:

```yaml
default_max_alerts_per_rule: 10
disable_baseline_rules: true
```

If no project rules are present, baseline rules are still applied unless disabled in `config.yaml`.

## Inputs

| Name | Default | Description |
|---|---|---|
| `cicd-sensor-version` | `v0.0.49` | Agent release to install; also supplies report tools when reusing an Agent. |
| `manager-url` | `""` | Optional cicd-sensor manager URL. |
| `manager-auth` | `manager-token` | Manager authentication: `manager-token` or `oidc`. |
| `manager-token` | `""` | Bearer token required with `manager-url` in token mode. Cannot be combined with OIDC. |
| `id-token-audience` | `""` | OIDC only. Defaults to the Manager URL origin, as resolved by the Agent. Must match the Manager's OIDC audience. |
| `enable-html-report` | `true` | Upload the `cicd-sensor-report` HTML artifact. |
| `enable-attestation-artifact` | `true` | Upload the `cicd-sensor-attestation` predicate artifact. |
| `enable-debug` | `false` | Upload debug logs, Runtime Event Log output, and raw result data. |
| `socket-path` | `/run/cicd-sensor/agent.sock` | Agent control socket path. |

## Manager authentication

Omit all Manager inputs to keep using project-local configuration. With
`manager-url`, configuration and rules come from the Manager instead of the
repository's `.cicd-sensor/` directory.

The existing Manager token setup remains supported:

```yaml
permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: cicd-sensor/cicd-sensor-action@main
        with:
          manager-url: https://manager.example.com
          manager-auth: manager-token # default; may be omitted
          manager-token: ${{ secrets.CICD_SENSOR_MANAGER_TOKEN }}
      - run: echo "Build steps go here"
```

For GitHub Actions OIDC, grant the job permission to request ID tokens and omit
`manager-token`:

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: cicd-sensor/cicd-sensor-action@main
        with:
          cicd-sensor-version: v0.0.49
          manager-url: https://manager.example.com
          manager-auth: oidc
          # Optional: must match auth.oidc.audience on the Manager.
          # id-token-audience: https://manager.example.com
      - run: echo "Build steps go here"
```

Pin the Action to a reviewed commit SHA for production workflows.
OIDC requires **Agent and CLI v0.0.49 or newer**. The Manager must also support
OIDC, enable `auth.oidc`, configure the GitHub issuer/JWKS and matching `audience`,
and allow the calling repository in `auth.oidc.allow`. Granting `id-token: write`
alone does not authorize a repository at the Manager. See the
[Manager OIDC configuration](https://github.com/cicd-sensor/cicd-sensor/blob/releases/v0.0.49/docs/developer-guide/manager.md#github-actions-oidc-authentication-project-scope).
Without `id-token-audience`, `https://manager.example.com/base` uses
`https://manager.example.com` as its audience.

The Action passes the runner's `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN` to `project start` through the child environment,
without sudo. The Agent obtains and refreshes JWTs, including during post and
final log delivery. OIDC creates no Manager token file and saves no credentials
in Actions state.

On self-hosted runners with an existing socket, `cicd-sensor-version` does not
upgrade the running Agent or `/usr/local/bin/cicd-sensor`. Upgrade both to at
least v0.0.49 and restart the Agent before using OIDC. The Action does not
precheck versions; the installed CLI and running Agent must support the OIDC
`project start` request. Unsupported versions cause setup to fail without
falling back to token authentication.
Reused Agents remain running after post; their host operator owns finalization
and Summary delivery through the existing job lifecycle.

## Outputs

| Name | Description |
|---|---|
| `attestation-artifact-id` | Artifact ID for `cicd-sensor-attestation`, or empty when disabled / failed. |
| `attestation-artifact-url` | Run-scoped URL for `cicd-sensor-attestation`, or empty when disabled / failed. |

## Development

See [docs/development.md](docs/development.md).
