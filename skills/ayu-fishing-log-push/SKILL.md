---
name: ayu-fishing-log-push
description: Use for the ayu-fishing-log project when local changes are ready to publish to GitHub. Codex cannot reliably run git add/commit/push in this workspace, so provide PowerShell commands for the user to paste after implementation and verification.
---

# Ayu Fishing Log Push Handoff

When work in `C:\Users\wells\Documents\Codex\ayu-fishing-log` is ready to publish:

1. Do the requested code/document changes.
2. Run verification checks that fit the change, such as `node --check script.js`, `git diff --stat`, and `git status --short --branch`.
3. Do not assume Codex can push. In this workspace, `git add` usually fails with `.git/index.lock: Permission denied`.
4. In the final response, include a PowerShell code block the user can paste.

Use this format, replacing files and message with the actual change:

```powershell
cd C:\Users\wells\Documents\Codex\ayu-fishing-log
git status
git add file1 file2 file3
git commit -m "Short commit message"
git push origin main
```

After the user says they pasted it or asks to confirm, check:

```powershell
git status --short --branch
git log --oneline --decorate -5
git rev-parse HEAD
git rev-parse origin/main
```

Report whether the working tree is clean and whether `HEAD` matches `origin/main`.
