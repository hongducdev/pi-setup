# pi-prompt-suggest — plan

Next-prompt suggestions rendered as **ghost text** in the pi editor.

Approach adapted from [`guwidoe/pi-prompt-suggester`](https://github.com/guwidoe/pi-prompt-suggester)
(reference read at v0.3.10; design decisions borrowed, code written independently).

## Decisions

| Topic | Decision | Rationale |
|---|---|---|
| UX | Ghost text via `setEditorComponent` + `CustomEditor` subclass | One inline suggestion accepted with one key; no second surface |
| Default state | **Off**. `--prompt-suggest` (or `/suggester on`) opts in | This extension replaces the session editor; it must never change the user's editor unasked |
| Trigger | `agent_settled` (fallback `agent_end`) | Fires only when no retry/compaction/continuation is pending — no wasted generations. Context comes from `getBranch()`, so `event.messages` is not needed |
| Cursor detection | `CURSOR_MARKER` constant from `@earendil-works/pi-tui` | Reference guesses the cursor with an ANSI regex; the explicit marker is exact. Coupling documented below |
| Model call | `ctx.modelRegistry.complete()` | Provider-neutral, ~20 lines. Reference hand-rolls auth + `streamSimple` in a 700-line client to control thinking level; not needed for v1 |
| Stale guard | `epoch` (per session) + `revision` (per suggestion) | Asynchronous results must never overwrite newer state |
| Accept keys | Space accepts **only from an empty editor**; Right accepts whenever the buffer is a prefix | A text-producing key must never silently accept over what the user is typing; a non-text key can |
| Tight width | No ghost at all below `MIN_INLINE_GHOST_WIDTH` (12) columns of room | A fallback layout means splicing lines into `Editor.render()` output; showing nothing is the safe degradation |
| Editor restore | `getEditorComponent()` is captured and restored on uninstall | Another extension may own the editor; we must not hand it back the built-in default |
| Storage | `~/.pi/agent/prompt-suggest/` | Avoids colliding with the reference package's `prompt-suggester/` |
| Skipped | Agentic seeder, A/B variants, NDJSON logs, transcript-cache strategy, migrations | Research apparatus of the reference, not needed for v1 |

## Known coupling (fragile by construction)

`findGhostAnchor()` depends on two internals of `Editor.render()`: the `CURSOR_MARKER` constant and the
reverse-video cursor block (`\x1b[7m…\x1b[0m`). If pi changes either, the anchor is not found and the
ghost stops rendering **silently**. Mitigations in place:

- The anchor rejects a cursor block that is not exactly one column wide, so a changed cursor shape
  fails closed instead of mis-rendering.
- `GhostSuggestionEditor.getAnchorMisses()` counts renders that wanted a ghost but found no caret;
  the count is shown in `/suggester status` so drift is visible instead of invisible.

This is an accepted risk for Phase 0, not a verified-safe design.

## Phases

### Phase 0 — Ghost editor (de-risk first) — DONE
- [x] `editor/accept-keys.ts` — `space`/`right` normalization + matching
- [x] `editor/ghost-editor.ts` — `GhostSuggestionEditor extends CustomEditor`; inline render after cursor; accept rules; suppression lifecycle; anchor-miss counter
- [x] `editor/ghost-install.ts` — install/uninstall/noop decision + previous-editor capture
- [x] `index.ts` — default-off wiring, `/suggester status|on|off|demo|clear`, `--prompt-suggest` flag
- [x] tests: 75 passing across 5 files

### Phase 1 — Suggestion pipeline — DONE
- [x] `app/turn-context.ts` — assistant text, recent user prompts, tool signals, touched files, turn status (from `getBranch()`) — pure
- [x] `app/capabilities.ts` — installed skills/commands/tools, ranked against the turn text — pure
- [x] `app/prompt-template.ts` — compact suggestion prompt — pure
- [x] `app/suggest.ts` — `modelRegistry.complete()`, `[no suggestion]` token, abort + single-flight, hard output cap — pure core
- [x] `config.ts` — persisted opt-in, model override, caps, tolerant parse, atomic write
- [x] automatic generation on `agent_settled`; clear + cancel on `agent_start`
- [x] usage counters and skip reasons in `/suggester status`; `/suggester prompt` writes the exact prompt
- [x] tests: 181 passing across 11 files

### Capability-aware suggestions

The prompt carries the installed skills, commands, prompt templates, and tools, so a suggestion can
be a capability invocation (for example `/ck:plan`) when that genuinely fits.

A large skill library is the cost problem: every description on every turn runs to thousands of
tokens. So ranking is split in two:

- **Ranked matches** (up to `capabilities.maxPerCategory` each) are rendered **with descriptions**,
  scored by keyword overlap against the last assistant message, the two most recent user prompts,
  and the turn's tool activity.
- **Everything else** is rendered as a **names-only** list (up to `capabilities.maxUnmatchedNames`).

Keyword ranking cannot see semantic relevance — "fix the parser" does not overlap "debug root
cause" — so dropping unmatched capabilities entirely would hide exactly the skills worth
suggesting. Names are cheap; descriptions are not.

### Privacy and cost (must stay visible)

A suggestion request sends the last assistant message, the two most recent user prompts, the turn's
tool activity, touched file names, and the ranked capability list to whichever provider the session
uses. `/suggester prompt` writes that same content to `~/.pi/agent/prompt-suggest/last-prompt.txt`
on disk. Both are inherent to the feature; the notice printed by `/suggester prompt` says so, and
`/suggester status` reports the assembled prompt size in tokens so the per-turn cost is visible
rather than assumed. The whole pipeline is off until `/suggester on`.

### Phase 2 — Deterministic sources
- [ ] history + saved prompts as fallback when no AI suggestion
- [ ] `/prompt-save`
- [ ] `>` sigil autocomplete for saved prompts (must delegate to `current`; `/` is rejected by the framework)

### Phase 3 — Project intent seed
- [ ] `store/paths.ts` + `store/seed.ts` — `seed.json` per project under `getAgentDir()`
- [ ] static seed from AGENTS.md / README / package.json / `git diff --stat`
- [ ] inject seed into the suggestion prompt
- [ ] coalesced reseed; `/suggester reseed`

## Verified API constraints (measured against installed pi, not assumed)

- `/` **cannot** be an autocomplete trigger char — `Editor.setAutocompleteTriggerCharacters` skips it; only single characters are accepted.
- Trigger characters are **merged** into `["@","#"]`, never replaced — `@` file completion and `#` keep working.
- `getSuggestions` is called on plain `Tab` regardless of trigger char → providers **must** delegate to `current`.
- `Editor.render()` emits `CURSOR_MARKER` (`\u001B_pi:c\u0007`) only while `focused`; layout is `[topBorder, ...contentLines, bottomBorder]`.
- `ctx.ui.setEditorComponent(factory | undefined)`; `ctx.sessionManager.getSessionFile(): string | undefined`.

## Validation

Automated (run and observed):

- `bun test` — 75 pass / 0 fail across 5 files. Includes real `Editor.render()` output via a mock TUI:
  border preservation and width limits swept at widths 1/5/12/20/40/80, multi-line rendering,
  tight-width degradation, CJK + emoji, prefix handling, suppression lifecycle, accept rules,
  and that app keybindings (extension shortcut, interrupt, ctrl+d, history) still reach `CustomEditor`.
- `bunx tsc --noEmit` — exit 0.
- The extension really loads: the registered `--prompt-suggest` flag appears in `pi --help` both with and
  without `-e`, proving personal-directory auto-discovery works.
- `pi -p "OK" -e <dir>` exits 0 with the extension enabled and disabled.
- From the installed pi source: `setEditorComponent` is a safe no-op in RPC mode, and `hasUI` exists only
  in interactive mode, so the `ctx.hasUI` guard is correct for RPC/print/json.

**Not verified — requires an interactive terminal:**

1. That the ghost text actually looks right on screen (position, colour, no flicker).
2. App keybindings in a real session (esc, ctrl+d, history, model switch).
3. Narrow-width and CJK/emoji appearance by eye (width *limits* are tested; appearance is not).
4. Coexistence with other extensions that call `setEditorComponent`.

To check by hand: `pi`, then `/suggester demo`, then clear the editor and read the ghost line.
`/suggester status` reports anchor misses — a non-zero count means the render coupling has drifted.
