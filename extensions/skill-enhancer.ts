import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageStartEvent,
  SessionCompactEvent,
  SessionEntry,
  SessionTreeEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

// P0: codex-style trigger wording.
// The strength comes from "must use + explain when skipping"; the model's default action flips from skipping to using.
const TRIGGER_GUIDELINES = [
  "skill 触发规则：用户提及了某个 skill，或当前任务明显匹配 available_skills 目录中某个 skill 的 description 时，这一轮必须使用该 skill；提及多个就全部使用。除非再次被提及，不要把 skill 延续到后面的轮次。",
  "skill 使用方式：决定使用某个 skill 后，先用 read 工具完整读完它的 SKILL.md，再开始任何任务动作。",
  "skill 宣告与问责：用一句话说明你正在使用哪个（些）skill、为什么；如果一个看似该用的 skill 你判断不用，说明理由。",
];

const BUDGET_RATIO = 0.02;
const USAGE_ENTRY_TYPE = "skill-usage";

// Message header of an expanded /skill:name command (produced by agent-session's _expandSkillCommand).
// Expansion only happens when the whole message starts with /skill:, so only match at the start of the text.
const MANUAL_SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">/;

interface SkillUsageData {
  ts: string;
  skill: string;
  path: string;
  via: "read" | "command";
  model?: string;
}

// The read tool accepts ~, @ prefix, file://, etc.; normalize to an absolute path here.
// pi's own resolvePath is not exported from the package, so only the most common forms are covered.
const normalizeReadPath = (raw: string, cwd: string): string => {
  let path = raw.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path.startsWith("file://")) path = path.slice(7);
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  return isAbsolute(path) ? path : resolve(cwd, path);
};

// The model may read through a symlinked path; aligning it with the catalog's filePath requires one realpath pass.
const canonicalOf = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

// Catalog token estimate: CJK (hanzi, kana, hangul, CJK punctuation, fullwidth forms) is close to 1.5 chars per token;
// chars/4 only holds for English. Emoji surrogate pairs still count as non-CJK; underestimating is the acceptable direction.
const estimateTokens = (text: string): number => {
  const cjk = (text.match(/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef]/gu) ?? []).length;
  return Math.ceil(cjk / 1.5) + Math.ceil((text.length - cjk) / 4);
};

const userMessageText = (message: MessageStartEvent["message"]): string => {
  if (message.role !== "user") return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
};

export default function (pi: ExtensionAPI) {
  // Skills invoked this session: filePath -> name
  const invoked = new Map<string, string>();
  // filePaths whose bodies were lost to compaction and have not been reloaded since
  const lost = new Set<string>();
  // In-flight skill file reads: toolCallId -> filePath
  const pendingReads = new Map<string, string>();
  // filePath -> name from the most recent before_agent_start catalog
  const skillNameByPath = new Map<string, string>();
  // realpath-resolved filePath -> catalog filePath, aligning reads that go through symlinks
  const rawPathByCanonical = new Map<string, string>();
  let budgetWarned = false;
  let stateRebuilt = false;
  let boundSessionManager: ExtensionContext["sessionManager"] | undefined;

  // Usage records are written as transcript custom entries: structured, never enter the LLM context, persist with the session.
  const recordUsage = (name: string, path: string, via: "read" | "command", ctx: ExtensionContext) => {
    const data: SkillUsageData = {
      ts: new Date().toISOString(),
      skill: name,
      path,
      via,
      model: ctx.model?.id,
    };
    pi.appendEntry<SkillUsageData>(USAGE_ENTRY_TYPE, data);
  };

  // pi compaction keeps the tail after firstKeptEntryId verbatim, so invocations inside the retained region
  // have not lost their bodies; only mark those outside it.
  // If the boundary cannot be found, stillPresent stays empty and everything is marked (conservative direction).
  const markLostForCompaction = (entries: SessionEntry[], firstKeptEntryId: string) => {
    const keptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
    const stillPresent = new Set<string>();
    if (keptIndex >= 0) {
      for (let index = keptIndex; index < entries.length; index++) {
        const entry = entries[index];
        if (entry.type === "custom" && entry.customType === USAGE_ENTRY_TYPE) {
          const data = entry.data as SkillUsageData | undefined;
          if (data?.path) stillPresent.add(data.path);
        }
      }
    }
    for (const path of invoked.keys()) {
      if (!stillPresent.has(path)) lost.add(path);
    }
  };

  // Replay the state machine over the current branch on the first before_agent_start:
  // usage entries record invocations, compaction entries record losses.
  // Survives session resume and extension reload via /reload.
  const rebuildState = (ctx: ExtensionContext) => {
    invoked.clear();
    lost.clear();
    const entries = ctx.sessionManager.getBranch();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.type === "compaction") {
        markLostForCompaction(entries.slice(0, index + 1), entry.firstKeptEntryId);
        continue;
      }
      if (entry.type === "custom" && entry.customType === USAGE_ENTRY_TYPE) {
        const data = entry.data as SkillUsageData | undefined;
        if (data?.path) {
          invoked.set(data.path, data.skill);
          lost.delete(data.path);
        }
      }
    }
  };

  // before_agent_start fires every turn; systemPromptOptions is a per-turn deep copy, so edits do not accumulate across turns.
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    // SDK embedders may share one extension instance across sessions; replay state whenever the session changes.
    if (boundSessionManager !== ctx.sessionManager) {
      boundSessionManager = ctx.sessionManager;
      stateRebuilt = false;
    }
    if (!stateRebuilt) {
      rebuildState(ctx);
      stateRebuilt = true;
    }

    const options = event.systemPromptOptions;

    // P0: do not push trigger rules when the catalog is empty, so the model does not go looking for skills that do not exist.
    if (options.skills.length > 0) {
      options.promptGuidelines.push(...TRIGGER_GUIDELINES);
    }

    skillNameByPath.clear();
    rawPathByCanonical.clear();
    for (const skill of options.skills) {
      skillNameByPath.set(skill.filePath, skill.name);
      rawPathByCanonical.set(canonicalOf(skill.filePath), skill.filePath);
    }

    // P2: skills whose bodies were lost to compaction move to the front of the catalog with a marker,
    // reminding the model to re-read them when needed.
    // When nothing was compacted or lost, do not touch the array, to avoid churning system prompt section diffs.
    if (lost.size > 0) {
      const lostSkills = options.skills.filter((skill) => lost.has(skill.filePath));
      const rest = options.skills.filter((skill) => !lost.has(skill.filePath));
      options.skills = [
        ...lostSkills.map((skill) => ({
          ...skill,
          description: `${skill.description}（本会话已调用，正文在压缩中丢失，如仍在使用该 skill，请先用 read 重新加载）`,
        })),
        ...rest,
      ];
    }

    // P1: warn once when the catalog estimate exceeds 2% of the window; re-arms after dropping back below and crossing again.
    const contextWindow = ctx.model?.contextWindow;
    if (contextWindow && contextWindow > 0) {
      const tokens = estimateTokens(formatSkillsForPrompt(options.skills, "read"));
      const over = tokens > contextWindow * BUDGET_RATIO;
      if (over && !budgetWarned) {
        budgetWarned = true;
        const percent = ((tokens / contextWindow) * 100).toFixed(1);
        ctx.ui.notify(
          `skill 目录约 ${tokens} token，占当前模型窗口 ${percent}%（阈值 2%）。可精简 skill 数量或缩短 description。`,
          "warning",
        );
      } else if (!over) {
        budgetWarned = false;
      }
    }
  });

  // Manual /skill: invocation: the expanded block is inlined into history with the user message; register the invocation but do not mark lost.
  // Use message_start rather than before_agent_start: /skill: queued during streaming does not fire before_agent_start,
  // while message_start fires once for each initial and queued message (agent-loop emits per initial/queued message).
  pi.on("message_start", (event: MessageStartEvent, ctx) => {
    const text = userMessageText(event.message);
    if (!text) return;
    const manual = MANUAL_SKILL_BLOCK.exec(text);
    if (!manual) return;
    const [, name, location] = manual;
    // Only accept skills known to the catalog: text pasted in the same format is not recorded as an invocation.
    if (!skillNameByPath.has(location)) return;
    invoked.set(location, name);
    lost.delete(location);
    recordUsage(name, location, "command", ctx);
  });

  pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx) => {
    if (event.toolName !== "read") return;
    const raw = (event.args as { path?: unknown })?.path;
    if (typeof raw !== "string" || raw.length === 0) return;
    let path = normalizeReadPath(raw, ctx.cwd);
    if (!skillNameByPath.has(path)) {
      const rawPath = rawPathByCanonical.get(canonicalOf(path));
      if (rawPath === undefined) return;
      path = rawPath;
    }
    pendingReads.set(event.toolCallId, path);
  });

  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx) => {
    const path = pendingReads.get(event.toolCallId);
    if (path === undefined) return;
    pendingReads.delete(event.toolCallId);
    if (event.isError) return;

    const name = skillNameByPath.get(path) ?? basename(dirname(path));
    invoked.set(path, name);
    // After re-reading, the body is back in history; the marker is no longer needed.
    lost.delete(path);

    recordUsage(name, path, "read", ctx);
  });

  // An overflow compaction mid-run only carries the marker into the system prompt at the next
  // before_agent_start (the next user submission); a threshold compaction before the prompt is marked in the same turn.
  pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
    markLostForCompaction(ctx.sessionManager.getBranch(), event.compactionEntry.firstKeptEntryId);
  });

  // /tree navigation stays in the same session and extension instance; a branch change must replay,
  // otherwise invoked/lost drift out of sync with the current branch.
  pi.on("session_tree", (_event: SessionTreeEvent, ctx) => {
    rebuildState(ctx);
  });
}
