# pi-skill-enhancer

Pi extension that strengthens the skill system: stricter trigger rules, a token-budget warning for the skill catalog, and reload markers for skills whose bodies were lost to compaction.

> Note: the trigger guidelines and catalog markers this extension injects are written in Chinese, by design — see [Why the prompts are in Chinese](#why-the-prompts-are-in-chinese).

## Install

```bash
pi install npm:pi-skill-enhancer
```

Or from git:

```bash
pi install git:github.com/ripley-xl/pi-skill-enhancer
```

## Features

**Mandatory trigger rules.** Appends three guidelines to the system prompt every turn: when the task clearly matches a skill's description in the catalog, the model must use that skill that turn; before using it, the model must read the full SKILL.md first; the model must state which skill it is using and why, and explain when it skips an apparently matching skill. Nothing is appended when the catalog is empty.

**Catalog budget warning.** Estimates the skill catalog's token count each turn and shows a TUI warning once it exceeds 2% of the active model's context window; it re-arms after the catalog drops back below the threshold. The estimator counts CJK characters (hanzi, kana, hangul, CJK punctuation, fullwidth forms) at 1.5 chars/token and everything else at 4 chars/token.

**Compaction-loss markers.** Compaction removes skill bodies from history. After a compaction, skills invoked this session whose bodies fell outside the retained tail are moved to the front of the catalog with a note appended to their description: already invoked this session, body lost to compaction, read it again if still in use. Reading the skill again removes the marker. Detection is based on the compaction entry's `firstKeptEntryId`, so invocations inside the retained region are not mis-marked; when the boundary cannot be found, all invoked skills are marked (over-marking preferred to missing). For overflow compactions mid-run, markers enter the system prompt on the next user submission.

**Usage records and state recovery.** Every skill invocation is written as a transcript custom entry (`customType: "skill-usage"`, with timestamp, skill, path, channel, model). Custom entries never enter the LLM context, cost no tokens, and persist with the session file. After session resume, `/reload`, or `/tree` branch switches, the extension replays the current branch's transcript to rebuild invocation and loss state, so markers stay correct across sessions and navigation.

## Design notes

This extension came out of comparing the skill mechanisms of pi, Codex CLI, Claude Code, and DeepSeek's harness (dsh) from source, then fixing pi's weak points through its extension API.

**P0 — trigger wording.** Adopted Codex-style wording because in the author's experience Codex's skill trigger rate is both high and accurate. The strength comes from two moves: "must use" plus "explain when skipping". Together they flip the model's default action from skipping to using; softer wording ("consider using") leaves skipping as the default. The final wording sits at medium-high intensity — must use this turn, use all that match, do not carry across turns, announce which and why, justify skipping — which dsh's wording independently corroborates as the engineering mainstream.

**P1 — catalog budget.** 1M-token windows are becoming standard, and 50 skills cost roughly 1.5% of one, so there is no hard cap — just a warning at 2%. A warning rather than truncation, because the catalog should stay complete; trimming skills is the user's call. The estimator counts CJK at 1.5 chars/token and everything else at 4, so Chinese-heavy catalogs are not overestimated by the usual chars/4 rule of thumb.

**P2 — compaction survival: catalog school, plus a marker.** The three harnesses split into two schools. Claude Code re-injects the bodies of previously invoked skills after compaction (up to 5K per skill, 25K total) — but it was forced into this: it does not resend the catalog after compaction, so re-injected bodies are the skill system's only lifeline. Codex and dsh keep the catalog alive and let the model reload on demand ("catalog school") — cheaper, and discovery is never paid for twice. pi's catalog lives in the system prompt, rebuilt every turn, so pi is naturally catalog school and Claude Code's constraint does not apply.

Catalog school's real failure mode is the model forgetting to reload and silently continuing with the instructions missing. P2 plugs that hole at near-zero cost: instead of re-injecting bodies, invoked skills move to the front of the catalog with a marker ("invoked this session; body lost to compaction; re-read if still in use"). Only catalog lines change; no body is ever re-injected.

Deliberately deferred: promoting invoked skill bodies into the system prompt itself, where compaction cannot touch them (pay once in resident window space instead of per compaction). That is the upgrade path if P3's usage data shows real behavior regression for rule-type skills — the kind that must hold every turn, like writing-style rules. Ship the cheap route first, measure, then decide.

**P3 — usage records live in the transcript.** Invocation records could have gone to a separate log file, but the transcript wins on every axis: custom entries are structured, never enter the LLM context (zero token cost), persist with the session file, and let the extension rebuild its state by replaying the current branch after resume, /reload, or /tree navigation. Cross-session usage statistics fall out for free — one grep over the sessions directory.

**Why the prompts are in Chinese.** The trigger guidelines and markers this extension injects are written in Chinese, deliberately. Chinese is more compact: the same instruction costs fewer tokens than English, and these lines ride along in every system prompt. It also plays to where the models are strongest — most open-weight models today come from Chinese labs (DeepSeek, Qwen, Kimi, GLM), which train and align heavily on Chinese instructions; Chinese instruction following is their home turf. The mix is intentional: proper nouns and tool names (skill, read) stay in English.

## Invocation detection

Both channels are covered:

- **Model-initiated read**: on `tool_execution_start` the `read` path is normalized and matched exactly against catalog `filePath` values; on `tool_execution_end` the call is registered only if it succeeded (matched by toolCallId). Supports `~`, `@` prefix, `file://`, relative paths, and symlinked paths aligned via realpath.
- **Manual `/skill:name`**: pi inlines the expanded `<skill name="..." location="...">` block into the user message. The extension recognizes the block at the message start and validates the location against the known catalog, so pasted text in the same format is not miscounted.

## Aggregating usage across sessions

Usage records live in session transcripts. To count invocations across sessions:

```bash
grep -h '"skill-usage"' ~/.pi/agent/sessions/*/*.jsonl 2>/dev/null | jq -r '.data.skill' | sort | uniq -c | sort -rn
```

(Session file directory depth may vary locally.)

## Known limitations

- **Windows path forms not covered**: `~\`, Git Bash `/c/...`, `file:///C:/...` — pi's full `resolvePath` accepts these but is not exported, and the extension's normalization only covers `~`, `~/`, `@`, `file://`, and relative paths. On Windows, reads using those forms succeed but are not recorded and not marked lost after compaction. Linux/macOS unaffected.
- **Emoji underestimate**: emoji surrogate pairs count as non-CJK in the token estimate, biasing low; the budget warning reacts later for descriptions heavy in emoji.
- **Conservative marking on missing boundary**: when a compaction entry's `firstKeptEntryId` is not found in the current branch (old sessions after a fork, etc.), all invoked skills are marked lost, which may add one unnecessary re-read reminder.
- **Multiple sessions sharing one extension instance**: standard CLI flows (`/new`, `/resume`, `/fork`, `/reload`) rebuild the extension instance each time and are unaffected. SDK embedders sharing one resourceLoader across sessions trigger a state replay on `ctx.sessionManager` identity change, but interleaved `before_agent_start` events apply catalog edits from the last event.

## License

MIT
