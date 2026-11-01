# End-to-end tests

Run these before every release, on the Claude Code version you release for:

```
python3 e2e/run.py manual
python3 e2e/run.py auto
python3 e2e/run.py auto-setting
python3 e2e/run.py off
python3 e2e/run.py guarded        # Linux with bwrap
```

On a machine with a machine policy, run only `guarded`: the policy's mod takes precedence over the repository's, so the others would test the installed copy.

Each run starts a real, interactive Claude Code in a detached tmux session and a fresh folder under `/tmp`, with this repository loaded through `--plugin-dir`. It types a scripted conversation into it and compacts it. It then checks the result twice: in the session transcript, and by asking the model to quote, word for word, the replies it can still see. A run ends with `PASSED` or `FAILED (n)` and a non-zero exit code.

| Scenario | What it does | What must hold |
| --- | --- | --- |
| `manual` | 10 code-word turns, every third with two `echo` tool calls, three with an @-mentioned 4k-token file the mod's rows do not show; `/summarize-up-to status`; `  /summarize-up-to 60%` typed after spaces, which sets the share for every `/compact`; a 15 s wait; ` /compact` typed after a space; Enter on what the box then holds | The leading-space command runs and empties the box, and stores the share to outlive the session. The confirmation gives counts, shares of what the model reads, and Claude Code's tokens, and nothing compacts. ` /compact` reaches neither the model nor compaction, and the box then holds `/compact`. Enter on it compacts (`manual`). The mod reports its cut. The summarized tokens the confirmation gave are within 0.6–1.6× of what left the model's input |
| `auto` | Code-word turns with pasted filler until Claude Code auto-compacts on its own, with the mod's partial auto-compaction on at 65%. The threshold comes from `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` | The compaction is `auto` |
| `auto-setting` | The same, with the threshold from the `autoCompactWindow` setting, as `/autocompact` writes it | The same |
| `auto-midturn` | Filler turns to just under the threshold (window 100k), then one turn of five one-at-a-time `cat` commands of about 6k tokens each and a closing reply | Claude Code auto-compacts between that turn's prompt and its reply; the turn finishes after it; a cut inside the turn keeps from exactly the command the mod names |
| `auto-default` | The same, at Claude Code's own default threshold. With claude-haiku-5-5 that is 967k tokens: about 15 minutes and roughly 5M tokens of haiku input | The same |
| each, after the compaction | | The mod's closing message is gone from the conversation. Verbatim text starts exactly where the mod reports it does. The newest replies stay verbatim and in order, the older ones appear only in the summary, which names them, and the model quotes the kept replies exactly and none of the others. The mod said it saved the cut for restarts, and `tools/relink.py`, reading only, finds the transcript whole as saved |
| each, then | `/exit`, and `claude --resume` of the same session in a fresh tmux session | The model again quotes exactly the kept replies and none of the summarized ones |
| `manual`, then | `/summarize-up-to status`; four more turns; a plain `/compact`; `/compact full` | The 60% share still stands after the restart; the plain `/compact` cuts at it again, nothing re-armed; `/compact full` summarizes everything, no reply kept |
| `guarded` | Claude Code's security default seated, as for a Team login: a test policy with one inert setting at `/etc/claude-code`, seen by this session alone (`e2e/guarded.py`), with auto-compaction on (window 100k). `/summarize-up-to status`; filler turns past the 67k threshold; `/compact`; ` /compact` typed after a space and Enter on what the box then holds; `/compact full` | The guard is seated. The mod warns when it loads, switches compaction off for the session, and says how to compact there anyway; the status leads with that warning and Claude Code reports auto-compaction off. Past the threshold nothing compacts, and no `/compact` runs, full or not. After `/reload-plugins` there is no false alarm about the switch, and the status still says compaction is off |
| `off` | `DISABLE_COMPACT=1` in a session compaction would reach, as after a reload under a machine policy that followed a guarded time. `/summarize-up-to status`; one turn; `/compact` | The mod warns when it loads; the status leads with that warning and still says compaction reaches the mod; `/compact` does not run |

Each auto scenario first reads the threshold from `/summarize-up-to status` and sizes its pastes so that the compaction comes after about ten turns. It reports the route Claude Code took, from its debug log. `E2E_MODEL=claude-haiku-4-5` runs a scenario on a 200k-window model, where Claude Code's default auto-compaction compacts directly instead of reactively. On that model the confirmation's token figures can exceed the 1.6× bound (see the main README), so those runs show the route and the cut, not a release gate. `--tag x` names the tmux session apart, to run copies of one scenario side by side.

Claude Code honours a managed-settings policy only at `/etc/claude-code`. `guarded` runs Claude Code in a private mount namespace (`bwrap`), whose `/etc` is the real `/etc`, entry by entry, plus the test policy. Claude Code rewrites its plugin registry when it adopts a policy, so the namespace also shows scratch copies of `~/.claude/plugins` and `settings.json`. Nothing on the machine changes. It needs Linux with `bwrap` and unprivileged user namespaces: Ubuntu 24.04 blocks those where `kernel.apparmor_restrict_unprivileged_userns` is 1, and there `guarded` cannot run.

Claude Code 2.1.302 draws the held-back line for ` /compact` only once the box's command menu closes. There the check finds the line in the transcript log and says so ("in the transcript, not on screen yet").

The mod edits the test session's transcript after each cut: only the stale parent ids that Claude Code writes, as described in the main README. The end-to-end runs exercise exactly that.

## Requirements

- tmux, Python 3, and the Claude Code release under test on `PATH`, or named by `CLAUDE_BIN=/path/to/claude`.
- A login where compaction reaches user mods. That means a personal account on a machine without managed settings: Team and Enterprise logins seat Claude Code's security default, which keeps compaction away from user mods. `/summarize-up-to status` tells you which you have.
- Network access for `claude-haiku-5-5` (or the `E2E_MODEL`). The three release scenarios together cost a few cents.

The test sessions read none of your own settings. They run with `--setting-sources project`, and the test folder's `.claude/settings.json` turns auto-compaction on or off and allows only `Bash(echo:*)`. They run in the default permission mode, so no permission or auto-mode dialog can appear. If any dialog does appear, the driver aborts rather than type into it.

Do not edit the repository while a run is going: Claude Code reloads a `--plugin-dir` mod when its files change, and a reload drops an armed cut.

## After a run

The tmux session is closed (keep it with `--keep`). The mod keeps the share each test folder set in its store, under that folder's path. The test folder and its `debug.txt` stay in `/tmp/sut-e2e-*`. The transcripts stay where Claude Code writes them: `~/.claude/projects/-private-tmp-sut-e2e-*` on macOS, `~/.claude/projects/-tmp-sut-e2e-*` on Linux. The run prints both paths. Remove them when you no longer need them:

```
rm -r /tmp/sut-e2e-* ~/.claude/projects/-*tmp-sut-e2e-*
```
