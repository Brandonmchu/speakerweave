# SpeakerWeave CLI

`sw` is the command-line companion for SpeakerWeave. It uses the same organization API token as the stable `/v1` REST API, so it is suitable for local operator workflows and shell scripts without storing an organizer JWT.

Python 3.11 or newer is required. Runtime dependencies are limited to Click and HTTPX.

## Install

From a SpeakerWeave checkout, install an isolated command with pipx:

```bash
pipx install ./cli
```

For development, use an editable install:

```bash
python -m pip install -e ./cli
```

## Quickstart

Create an organization API token under **Settings → API tokens**, then log in:

```bash
sw auth login
sw auth status
sw events list
sw submissions list --status pending
sw ask "What needs my attention today?"
```

`sw auth login` defaults to `https://speakerweave.com`, verifies the token with a small authenticated request, and writes it to `~/.config/speakerweave/config.toml` with mode `0600`. `SPEAKERWEAVE_TOKEN` can supply a token without writing it to disk. Global `--server` and `--token` options override stored configuration; token precedence is flag, environment, then file.

Event-scoped commands automatically use the currently running event, then the nearest upcoming event, then the newest event returned by the server. Run `sw events list` to see the available events.

## Command reference

| Command | Purpose |
|---|---|
| `sw auth login` | Prompt for, verify, and securely store a server and API token. |
| `sw auth status` | Verify and show the active server, masked token, and credential source. |
| `sw auth logout` | Remove the stored configuration file. |
| `sw events list [--json]` | List organization events. |
| `sw submissions list [--status S] [--track T] [--json]` | List and filter submissions for the active event. |
| `sw submissions get ID [--json]` | Show one submission. |
| `sw submissions accept ID [--feedback TEXT]` | Accept a submission and optionally store decision feedback. |
| `sw submissions decline ID [--feedback TEXT]` | Decline a submission and optionally store decision feedback. |
| `sw submissions queue ID [--feedback TEXT]` | Move a submission into the acceptance queue. |
| `sw speakers list [--filter TEXT] [--json]` | List or search speakers. |
| `sw speakers get ID [--json]` | Show one speaker profile. |
| `sw speakers import FILE.csv` | Import speakers and report created, updated, skipped, errors, and ignored columns. |
| `sw schedule show [--json]` | Show the schedule grouped by day in the event timezone. |
| `sw schedule auto-place` | Place unscheduled sessions into conflict-free slots. |
| `sw schedule publish` | Record publication and print the public schedule URL. |
| `sw content status [--missing-only] [--json]` | Show content deliverables and optionally only missing items. |
| `sw content remind` | Queue deduplicated reminders for required missing content. |
| `sw triage [--json]` | Run and rank AI triage suggestions for the open evaluation plan. |
| `sw ask "QUESTION"` | Send a one-shot question to Ask SpeakerWeave. |
| `sw ask -i` | Open a conversation loop that keeps history for the current process. |

All list and get commands provide `--json` for scripting. Human output uses aligned tables by default. Successful commands exit `0`, API and network failures exit `1`, and invalid command usage exits `2`.

Global overrides must appear before the command:

```bash
sw --server https://conference.example --token dais_... events list --json
```

## Development and tests

The CLI is a separate Python package; its tests are intentionally not part of the API suite.

```bash
cd cli
pip install -e '.[dev]'
pytest
```

Tests use HTTPX mock transports and never call a live SpeakerWeave deployment.
