#!/usr/bin/env python3
"""Run a command with a test policy at /etc/claude-code, seen by it alone.

    guarded.py <policy folder> <command> [args...]

Claude Code reads managed settings only from /etc/claude-code, and seats its
security default where a policy is there, as in Team and Enterprise
organizations. This runs the command in a private mount namespace (bwrap,
Linux) whose /etc is the real /etc, entry by entry, plus the policy folder as
/etc/claude-code. Nothing on the host changes, and no other process sees it.
"""
import os
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
args += ["--ro-bind", policy, "/etc/claude-code", "--"] + argv
os.execvp("bwrap", args)
