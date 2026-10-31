# End-to-end tests

Run both scenarios before every release, on the Claude Code version you release for:

```
python3 e2e/run.py manual
python3 e2e/run.py auto
```

Each run starts a real, interactive Claude Code in a detached tmux session and a fresh folder under `/tmp`, with this repository loaded through `--plugin-dir`. It types a scripted conversation into it and compacts it. It then checks the result twice: in the session transcript, and by asking the model to quote, word for word, the replies it can still see. A run ends with `PASSED` or `FAILED (n)` and a non-zero exit code.

| Scenario | What it does | What must hold |
| --- | --- | --- |
| `manual` | 10 code-word turns, every third with two `echo` tool calls; `/summarize-up-to status`; `/summarize-up-to 60%`; a 15 s wait; `/compact` | The command only arms and confirms (summarized and kept counts), and nothing compacts until `/compact`. Then the compaction is `manual`, the mod reports its cut, the newest replies stay verbatim in order, the older ones are only in the summary, and the model quotes the kept replies exactly and none of the others |
| `auto` | Turns with about 4k tokens of pasted filler each, until Claude Code auto-compacts on its own (auto-compact window 100k), with the mod's partial auto-compaction on at 65% | The compaction is `auto`, and everything listed for `manual` after `/compact` holds |

Claude Code keeps a message or two before the cut in addition to what the mod hands back, so the checks accept a kept part that starts up to one reply earlier than the reported cut.

## Requirements

- tmux, Python 3, and the Claude Code release under test on `PATH`, or named by `CLAUDE_BIN=/path/to/claude`.
- A login where compaction reaches user mods. That means a personal account on a machine without managed settings: Team and Enterprise logins seat Claude Code's security default, which keeps compaction away from user mods. `/summarize-up-to status` tells you which you have.
- Network access for `claude-haiku-5-5`. A pair of runs costs a few cents.

The test sessions read none of your own settings. They run with `--setting-sources project`, and the test folder's `.claude/settings.json` turns auto-compaction on or off and allows only `Bash(echo:*)`. They run in the default permission mode, so no permission or auto-mode dialog can appear. If any dialog does appear, the driver aborts rather than type into it.

## After a run

The tmux session is closed (keep it with `--keep`). The test folder and its `debug.txt` stay in `/tmp/sut-e2e-*`. The transcripts stay where Claude Code writes them: `~/.claude/projects/-private-tmp-sut-e2e-*` on macOS, `~/.claude/projects/-tmp-sut-e2e-*` on Linux. The run prints both paths. Remove them when you no longer need them:

```
rm -r /tmp/sut-e2e-* ~/.claude/projects/-*tmp-sut-e2e-*
```
