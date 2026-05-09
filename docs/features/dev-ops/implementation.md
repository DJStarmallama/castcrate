# Feature: dev-ops — Activate Beast Mode hooks & skills

## Executive Summary

Beast Mode templates were installed by `/install-beast-mode` (slash commands, agents, hook templates, doc templates, format references). What is **not yet active**:

- Hooks are present at `.claude/hooks/` but not registered in `.claude/settings.json` / `.claude/settings.local.json`.
- Skill system has no `skill-rules.json` yet (skills will accumulate over time via `/document-feature`).
- `build-check.ts` hook is shipped as a generic template — must be customised for the castcrate monorepo's typecheck command.

This plan walks through activating those pieces. **All steps are optional** — slash commands and agents already work without any of this.

---

## Phase 1 — Configure & Test Hooks

### Tasks

#### 1. Confirm `tsx` is on PATH

Already installed globally — verified at `/opt/homebrew/bin/tsx`. The TypeScript hooks use `#!/usr/bin/env tsx`.

#### 2. Customise `build-check.ts` for the monorepo

Edit `.claude/hooks/build-check.ts`:

- `BUILD_COMMAND` → `pnpm typecheck` (runs `tsc --noEmit` across all workspaces via `pnpm -r typecheck`).
- `COMMAND_NAME` → `typecheck` (used in display only).

Optional: also add a lint step as a separate hook or chain (`pnpm lint`).

#### 3. Register hooks in `.claude/settings.local.json`

The repo's `settings.json` is committed; per-user hook config belongs in `settings.local.json` (gitignored). Add to it:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "./.claude/hooks/skill-reminder.ts" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "./.claude/hooks/edit-tracker.ts" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "./.claude/hooks/build-check.ts" }
        ]
      }
    ]
  }
}
```

A reference template exists at `.claude/settings.hooks.json`.

#### 4. Verify hook executability

Already done by `install-templates.sh` (`chmod +x .claude/hooks/*.ts`). If a hook stops running, check:

```bash
ls -l .claude/hooks/
```

#### 5. Smoke-test each hook

- **skill-reminder** — start a prompt with a stack keyword (e.g. "fastify"). Should suggest a skill if one exists.
- **edit-tracker** — make any edit. Confirm `.claude/session-edits.json` is written.
- **build-check** — at end of an editing turn, should run `pnpm typecheck` and report status.

### Acceptance criteria

- All three hooks fire without error during a normal session.
- `build-check` reports typecheck failures if any are introduced.
- `.claude/session-edits.json` is gitignored (already covered by Beast Mode `.gitignore` block).

---

## Phase 2 — Initialise the skill system

### Tasks

1. Copy the rules template:
   ```bash
   cp .claude/skill-rules.template.json .claude/skills/skill-rules.json
   ```

   Or write directly:
   ```json
   { "rules": [] }
   ```

2. **Do not author skills speculatively.** Skills document working code patterns extracted via `/document-feature <name>` after a feature ships.

### Acceptance criteria

- `.claude/skills/skill-rules.json` exists with an empty rules array.
- No skill folders in `.claude/skills/` yet (correct — they grow over time).

---

## Phase 3 — Validate the full workflow

### Tasks

1. Pick a small, real change (a one-file fix or a tiny refactor).
2. Run `/plan-feature <name>` → confirm `solution-architect` writes `docs/features/<name>/implementation.md`.
3. Run `/start-feature <name>` → confirm `context.md` and `tasks.md` are created.
4. Run `/proceed` → confirm `frontend-dev` or `backend-dev` picks up tasks and updates docs as it goes.
5. End with `/update-feature <name>` → confirm context is persisted before the session ends.

### Acceptance criteria

- A complete plan → start → proceed → update cycle leaves consistent feature docs and a working build.
- The Stop hook (`build-check`) catches regressions before the session ends.

---

## Castcrate-specific notes

- **Typecheck command:** `pnpm typecheck` (workspace-recursive). Avoid `tsc` directly — won't pick up project references.
- **Lint:** only `apps/web` has ESLint configured; `pnpm lint` is `pnpm -r --if-present lint`, so it's safe to run repo-wide.
- **Tests:** `pnpm test` runs Vitest in both `apps/server` and (if added) the web app. Don't add it to the Stop hook by default — too slow for every turn. Better as a manual pre-commit step.
- **Server hot reload:** `tsx watch` on `apps/server/src/index.ts`. Hooks should not race with it (they don't touch source).
- **WebTorrent / Chromecast paths:** hooks won't help here — these need real-LAN verification, see `docs/technical-design.md` §8.

---

## Status

- [x] Templates installed (commands, agents, hooks, doc templates, format references)
- [x] solution-architect, frontend-dev, backend-dev agents created
- [x] mission-statement.md and technical-design.md written
- [ ] Phase 1 — hooks registered & smoke-tested
- [ ] Phase 2 — `skill-rules.json` initialised
- [ ] Phase 3 — workflow validated end-to-end on a real task
