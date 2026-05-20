> 🚧 Currently under development. Not yet ready for use.

# cicd-sensor-action

GitHub Action for running [cicd-sensor](https://github.com/cicd-sensor/cicd-sensor) on a Linux GitHub Actions runner.

With the default settings, it starts the cicd-sensor agent before your workload, records runtime activity, and uploads the HTML report after the job. Optional inputs can enable attestation artifacts, cicd-sensor Manager for centralized configuration, and cloud delivery for Job Result Log, Detection Log, and Runtime Telemetry Log.

## Usage

```yaml
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: cicd-sensor/cicd-sensor-action@v0.0.2
      - uses: actions/checkout@v6

      - name: Build
        run: make test
```

- The action supports GitHub-hosted Linux VM runners, including x64 and arm64 labels such as `ubuntu-latest`, `ubuntu-24.04`, `ubuntu-22.04`,
`ubuntu-24.04-arm`, and `ubuntu-22.04-arm`.
- `ubuntu-slim` is not supported because it runs in a container on a shared VM and does not provide the host eBPF environment cicd-sensor needs. See [Choosing the runner for a job](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job) for the current GitHub runner labels.

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
| `enable-attestation-artifact` | `false` | Upload the `cicd-sensor-attestation` predicate artifact. |
| `enable-debug` | `false` | Upload debug logs and raw result data. |
| `socket-path` | `/run/cicd-sensor/agent.sock` | Agent control socket path. |

## Outputs

| Name | Description |
|---|---|
| `attestation-artifact-id` | Artifact ID for `cicd-sensor-attestation`, or empty when disabled / failed. |
| `attestation-artifact-url` | Run-scoped URL for `cicd-sensor-attestation`, or empty when disabled / failed. |

## Development

See [docs/development.md](docs/development.md).