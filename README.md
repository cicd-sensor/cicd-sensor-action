> 🚧 Currently under development. Not yet ready for use.

# cicd-sensor-action

GitHub Action for running [cicd-sensor](https://github.com/cicd-sensor/cicd-sensor) on a Linux GitHub Actions runner.

Published as `cicd-sensor/cicd-sensor-action`. See the [GitHub-hosted runner guide](https://cicd-sensor.github.io/user-guide/github-hosted.html) for usage.

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

If no project rules are present, baseline rules are still applied.

## Inputs

| Name | Default | Description |
|---|---|---|
| `manager-url` | `""` | Optional cicd-sensor manager URL. |
| `manager-token` | `""` | Bearer token for the manager. Required when `manager-url` is set. |
| `enable-html-report` | `true` | Upload the `cicd-sensor-report` HTML artifact. |
| `enable-attestation-artifact` | `true` | Upload the `cicd-sensor-attestation` predicate artifact. |
| `enable-debug` | `false` | Upload debug logs, Runtime Telemetry Log output, and raw result data. |
| `socket-path` | `/run/cicd-sensor/agent.sock` | Agent control socket path. |

## Outputs

| Name | Description |
|---|---|
| `attestation-artifact-id` | Artifact ID for `cicd-sensor-attestation`, or empty when disabled / failed. |
| `attestation-artifact-url` | Run-scoped URL for `cicd-sensor-attestation`, or empty when disabled / failed. |

## Development

See [docs/development.md](docs/development.md).
