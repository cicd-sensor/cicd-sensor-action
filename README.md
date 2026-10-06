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
| `manager-url` | `""` | Optional cicd-sensor manager URL. |
| `manager-token` | `""` | Bearer token for the manager. Required when `manager-url` is set. |
| `enable-html-report` | `true` | Upload the `cicd-sensor-report` HTML artifact. |
| `enable-attestation-artifact` | `true` | Upload the `cicd-sensor-attestation` predicate artifact. |
| `enable-debug` | `false` | Upload debug logs, Runtime Event Log output, and raw result data. |
| `socket-path` | `/run/cicd-sensor/agent.sock` | Agent control socket path. |

## Outputs

| Name | Description |
|---|---|
| `attestation-artifact-id` | Artifact ID for `cicd-sensor-attestation`, or empty when disabled / failed. |
| `attestation-artifact-url` | Run-scoped URL for `cicd-sensor-attestation`, or empty when disabled / failed. |

## Development

See [docs/development.md](docs/development.md).
