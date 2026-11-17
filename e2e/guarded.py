#!/usr/bin/env python3
"""Run a command with a test policy at /etc/claude-code, seen by it alone.

    guarded.py <policy folder> <command> [args...]
    guarded.py - <command> [args...]      the machine's policy hidden instead

Claude Code reads managed settings only from /etc/claude-code, and seats its
security default where a policy is there, as in Team and Enterprise
organizations. This runs the command in a private mount namespace (bwrap,
Linux) whose /etc is the real /etc, entry by entry, plus the policy folder as
/etc/claude-code. Claude Code rewrites its plugin registry when it adopts a
policy, so it also sees scratch copies of ~/.claude/plugins and settings.json.
Nothing on the host changes, and no other process sees it. With "-" for the
folder, the command sees no /etc/claude-code at all, so a machine policy that
seats an installed copy of the mod does not load it ahead of the copy under test.
"""
import os
import shutil
import sys

policy, argv = sys.argv[1], sys.argv[2:]
args = ["bwrap", "--dev-bind", "/", "/", "--tmpfs", "/etc"]
for name in sorted(os.listdir("/etc")):
    path = "/etc/" + name
    if name == "claude-code":
        continue
    if os.path.islink(path):
        args += ["--symlink", os.readlink(path), path]
    else:
        args += ["--dev-bind", path, path]
if policy != "-":
    args += ["--ro-bind", policy, "/etc/claude-code"]

# bwrap binds real paths: ~/.claude may be a symlink.
home = os.path.realpath(os.path.expanduser("~/.claude"))
scratch = (policy.rstrip("/") if policy != "-" else os.environ.get("E2E_WORK", "/tmp/sut-e2e-hidden")) + "-home"
if os.path.isdir(home + "/plugins"):
    if not os.path.exists(scratch + "/plugins"):
        shutil.copytree(home + "/plugins", scratch + "/plugins", symlinks=False, ignore_dangling_symlinks=True)
    args += ["--bind", scratch + "/plugins", home + "/plugins"]
if os.path.isfile(home + "/settings.json"):
    if not os.path.exists(scratch + "/settings.json"):
        shutil.copy2(home + "/settings.json", scratch + "/settings.json")
    args += ["--bind", scratch + "/settings.json", home + "/settings.json"]
os.execvp("bwrap", args + ["--"] + argv)
