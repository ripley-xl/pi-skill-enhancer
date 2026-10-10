# pi-skill-enhancer

Pi extension that strengthens the skill system: stricter trigger rules, a token-budget warning for the skill catalog, and reload markers for skills whose bodies were lost to compaction.

> Note: the trigger guidelines this extension appends to the system prompt are written in Chinese. The extension itself is language-neutral.

## Install

```bash
pi install git:github.com/ripley-xl/pi-skill-enhancer
```

Once published to npm, equivalently:

```bash
pi install npm:pi-skill-enhancer
```

## Features

**Mandatory trigger rules.** Appends three guidelines to the system prompt every turn: when the task clearly matches a skill's description in the catalog, the model must use that skill that turn; before using it, the model must read the full SKILL.md first; the model must state which skill it is using and why, and explain when it skips an apparently matching skill. Nothing is appended when the catalog is empty.

**Catalog budget warning.** Estimates the skill catalog's token count each turn and shows a TUI warning once it exceeds 2% of the active model's context window; it re-arms after the catalog drops back below the threshold. The estimator counts CJK characters (hanzi, kana, hangul, CJK punctuation, fullwidth forms) at 1.5 chars/token and everything else at 4 chars/token.

**Compaction-loss markers.** Compaction removes skill bodies from history. After a compaction, skills invoked this session whose bodies fell outside the retained tail are moved to the front of the catalog with a note appended to their description: already invoked this session, body lost to compaction, read it again if still in use. Reading the skill again removes the marker. Detection is based on the compaction entry's `firstKeptEntryId`, so invocations inside the retained region are not mis-marked; when the boundary cannot be found, all invoked skills are marked (over-marking preferred to missing). For overflow compactions mid-run, markers enter the system prompt on the next user submission.

**Usage records and state recovery.** Every skill invocation is written as a transcript custom entry (`customType: "skill-usage"`, with timestamp, skill, path, channel, model). Custom entries never enter the LLM context, cost no tokens, and persist with the session file. After session resume, `/reload`, or `/tree` branch switches, the extension replays the current branch's transcript to rebuild invocation and loss state, so markers stay correct across sessions and navigation.

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
