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

// P0：codex 式触发措辞。强度来源是"必须用 + 跳过要解释"，模型默认动作从跳过翻转为使用。
const TRIGGER_GUIDELINES = [
  "skill 触发规则：用户提及了某个 skill，或当前任务明显匹配 available_skills 目录中某个 skill 的 description 时，这一轮必须使用该 skill；提及多个就全部使用。除非再次被提及，不要把 skill 延续到后面的轮次。",
  "skill 使用方式：决定使用某个 skill 后，先用 read 工具完整读完它的 SKILL.md，再开始任何任务动作。",
  "skill 宣告与问责：用一句话说明你正在使用哪个（些）skill、为什么；如果一个看似该用的 skill 你判断不用，说明理由。",
];

const BUDGET_RATIO = 0.02;
const USAGE_ENTRY_TYPE = "skill-usage";

// /skill:名称 展开后的消息头（agent-session 的 _expandSkillCommand 产物），
// 展开只在整条消息以 /skill: 开头时发生，所以只匹配文本开头。
const MANUAL_SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">/;

interface SkillUsageData {
  ts: string;
  skill: string;
  path: string;
  via: "read" | "command";
  model?: string;
}

// read 工具允许 ~、@ 前缀、file:// 等形式，这里对齐到绝对路径；
// resolvePath 未从包里导出，只补最常见的三种形式。
const normalizeReadPath = (raw: string, cwd: string): string => {
  let path = raw.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path.startsWith("file://")) path = path.slice(7);
  if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
  return isAbsolute(path) ? path : resolve(cwd, path);
};

// 模型可能经符号链接路径 read，与目录里的 filePath 对齐需要追一次 realpath。
const canonicalOf = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

// 目录 token 估算：CJK（汉字、假名、Hangul、CJK 标点、全角符号）接近 1.5 字符一个 token，
// chars/4 只对英文成立；emoji 代理对仍按非 CJK 估，低估方向可接受。
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
  // 本会话调用过的 skill：filePath -> name
  const invoked = new Map<string, string>();
  // 正文已在压缩中丢失、之后尚未重新加载的 skill filePath
  const lost = new Set<string>();
  // 进行中的 skill 文件 read：toolCallId -> filePath
  const pendingReads = new Map<string, string>();
  // 最近一次 before_agent_start 目录里的 filePath -> name
  const skillNameByPath = new Map<string, string>();
  // realpath 后的 filePath -> 目录里的 filePath，对齐符号链接路径的 read
  const rawPathByCanonical = new Map<string, string>();
  let budgetWarned = false;
  let stateRebuilt = false;
  let boundSessionManager: ExtensionContext["sessionManager"] | undefined;

  // 调用记录写成 transcript 里的 custom entry：结构化、不进 LLM 上下文、随会话持久化。
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

  // pi 压缩会原文保留 firstKeptEntryId 之后的尾部，落在保留区内的调用正文并未丢失，
  // 只标保留区之外的；找不到边界时 stillPresent 为空，退化为全标（保守方向）。
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

  // 首次 before_agent_start 时按当前分支重放状态机：usage 条目记调用，compaction 条目记丢失。
  // 会话 resume 和 /reload 重载扩展后都能恢复。
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

  // before_agent_start 每轮触发；systemPromptOptions 是当轮的深拷贝，改动不跨轮累积。
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    // SDK 嵌入方可能让多个会话共用同一扩展实例，会话变了必须重放状态。
    if (boundSessionManager !== ctx.sessionManager) {
      boundSessionManager = ctx.sessionManager;
      stateRebuilt = false;
    }
    if (!stateRebuilt) {
      rebuildState(ctx);
      stateRebuilt = true;
    }

    const options = event.systemPromptOptions;

    // P0：目录为空时不推触发规则，避免模型去找不存在的 skill。
    if (options.skills.length > 0) {
      options.promptGuidelines.push(...TRIGGER_GUIDELINES);
    }

    skillNameByPath.clear();
    rawPathByCanonical.clear();
    for (const skill of options.skills) {
      skillNameByPath.set(skill.filePath, skill.name);
      rawPathByCanonical.set(canonicalOf(skill.filePath), skill.filePath);
    }

    // P2：压缩后正文丢失的 skill 排到目录最前并标注，提醒模型需要时重新 read。
    // 未压缩或没有丢失时不动数组，避免触发 system prompt 分节 diff。
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

    // P1：目录估算超 2% 窗口时提示一次，回落后重新越过再报。
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

  // 手动 /skill: 调用：展开块随用户消息内联进历史，登记调用但不标 lost。
  // 用 message_start 而不是 before_agent_start：流式期间排队的 /skill: 不触发 before_agent_start，
  // 而 message_start 对初始消息和排队消息都各触发一次（agent-loop 对每条 initial/queued 消息 emit）。
  pi.on("message_start", (event: MessageStartEvent, ctx) => {
    const text = userMessageText(event.message);
    if (!text) return;
    const manual = MANUAL_SKILL_BLOCK.exec(text);
    if (!manual) return;
    const [, name, location] = manual;
    // 只认目录里的已知 skill：用户粘贴以该格式开头的文本不会被记成调用。
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
    // 重新 read 后正文已回到历史，不再需要标注。
    lost.delete(path);

    recordUsage(name, path, "read", ctx);
  });

  // run 中途的 overflow 压缩要等下一次 before_agent_start（下一个用户提交）才把标注带进
  // system prompt；prompt 前的阈值压缩当轮即可标注。
  pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
    markLostForCompaction(ctx.sessionManager.getBranch(), event.compactionEntry.firstKeptEntryId);
  });

  // /tree 导航停留在同一会话与扩展实例，分支变了必须重放，否则 invoked/lost 与当前分支脱节。
  pi.on("session_tree", (_event: SessionTreeEvent, ctx) => {
    rebuildState(ctx);
  });
}
