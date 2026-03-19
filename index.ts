import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { complete, type Model } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  DynamicBorder,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
  type SessionMessageEntry,
  type SessionManager as SessionManagerType,
  type BranchSummaryEntry,
  type CompactionEntry,
  keyHint,
  rawKeyHint,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  Spacer,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type SessionReader = Pick<
  SessionManagerType,
  "getEntries" | "getLeafId" | "getBranch" | "getSessionName" | "getSessionFile" | "getCwd" | "getLabel"
>;

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

type VisibleNode = {
  id: string;
  entry: VisibleEntry;
  label?: string;
  children: VisibleNode[];
};

type VisibleEntry = SessionMessageEntry | BranchSummaryEntry | CompactionEntry;

type BranchNode = {
  id: string;
  startId: string;
  endId: string;
  entries: VisibleNode[];
  children: BranchNode[];
  heuristicLabel: string;
  llmLabel?: string;
  hasLabel: boolean;
  labels: string[];
  active: boolean;
  activeLeaf: boolean;
  branchSummaryCount: number;
  compactionCount: number;
  userCount: number;
  assistantCount: number;
  toolCallCount: number;
  textWordCount: number;
  startedAt: string;
  endedAt: string;
};

type FlatBranchRow = {
  branch: BranchNode;
  depth: number;
  ancestorsHasMore: boolean[];
  isLast: boolean;
};

type TreeseeData = {
  roots: BranchNode[];
  flatRows: FlatBranchRow[];
  sessionName?: string;
  sessionFile?: string;
  cwd: string;
  activeLeafId: string | null;
};

type SummaryCacheFile = {
  version: 1;
  entries: Record<string, { summary: string; updatedAt: string }>;
};

const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "treesee");
const CACHE_PATH = path.join(CACHE_DIR, "cache.json");
const MAX_LABEL_WORDS = 5;
const SESSION_LIST_WINDOW = 12;

let summaryCache: SummaryCacheFile | null = null;

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function words(text: string): string[] {
  return text
    .replace(/[`*_>#\-\[\](){},.!?:;"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function shortWords(text: string, maxWords = MAX_LABEL_WORDS): string {
  const picked = words(text).slice(0, maxWords);
  if (picked.length === 0) return "Untitled branch";
  return picked.join(" ");
}

function summarizeSnippet(text: string, maxWords: number): string {
  return words(text).slice(0, maxWords).join(" ");
}

function abbreviatePath(value: string, maxWidth = 44): string {
  const home = os.homedir();
  let text = value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (text.length <= maxWidth) return text;

  const parts = text.split("/").filter(Boolean);
  if (parts.length <= 2) return text.slice(-maxWidth);

  const prefix = parts[0] === "~" ? "~" : parts[0]!;
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const tail = parts.slice(parts.length - keep);
    const candidate = `${prefix}/…/${tail.join("/")}`;
    if (candidate.length <= maxWidth || keep === 1) return candidate;
  }
  return text;
}

function padRightVisible(text: string, width: number): string {
  const delta = width - visibleWidth(text);
  return delta > 0 ? text + " ".repeat(delta) : text;
}

function padLeftVisible(text: string, width: number): string {
  const delta = width - visibleWidth(text);
  return delta > 0 ? " ".repeat(delta) + text : text;
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: string; text?: string };
    if (record.type === "text" && typeof record.text === "string") {
      out.push(record.text);
    }
  }
  return out;
}

function extractToolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const names: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: string; name?: string };
    if (record.type === "toolCall" && typeof record.name === "string") {
      names.push(record.name);
    }
  }
  return [...new Set(names)];
}

function countToolCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (part) => part && typeof part === "object" && (part as { type?: string }).type === "toolCall",
  ).length;
}

function countTextWords(content: unknown): number {
  return extractTextBlocks(content)
    .flatMap((text) => words(text))
    .length;
}

function getMessageRole(entry: SessionEntry): string | undefined {
  return entry.type === "message" ? entry.message.role : undefined;
}

function isVisibleEntry(entry: SessionEntry): entry is VisibleEntry {
  if (entry.type === "branch_summary" || entry.type === "compaction") return true;
  if (entry.type !== "message") return false;
  return entry.message.role === "user" || entry.message.role === "assistant";
}

function isSpecialEntry(entry: VisibleEntry): boolean {
  return entry.type === "branch_summary" || entry.type === "compaction";
}

function buildVisibleTree(reader: SessionReader): VisibleNode[] {
  const entries = reader.getEntries();
  const childrenByParent = new Map<string | null, SessionEntry[]>();

  for (const entry of entries) {
    const siblings = childrenByParent.get(entry.parentId) ?? [];
    siblings.push(entry);
    childrenByParent.set(entry.parentId, siblings);
  }

  const buildProjected = (entry: SessionEntry): VisibleNode[] => {
    const rawChildren = childrenByParent.get(entry.id) ?? [];
    const childNodes = rawChildren.flatMap(buildProjected);

    if (!isVisibleEntry(entry)) return childNodes;

    return [
      {
        id: entry.id,
        entry,
        label: reader.getLabel(entry.id),
        children: childNodes,
      },
    ];
  };

  const roots = childrenByParent.get(null) ?? [];
  return roots.flatMap(buildProjected);
}

function activeVisibleIds(reader: SessionReader): Set<string> {
  const branch = reader.getBranch();
  return new Set(branch.filter(isVisibleEntry).map((entry) => entry.id));
}

function activeVisibleLeafId(reader: SessionReader): string | null {
  const branch = reader.getBranch().filter(isVisibleEntry);
  return branch.length > 0 ? branch[branch.length - 1]!.id : null;
}

function labelsForEntries(reader: SessionReader, entries: VisibleNode[]): string[] {
  return entries
    .map((entry) => reader.getLabel(entry.id))
    .filter((label): label is string => Boolean(label));
}

function collectBranchEntries(start: VisibleNode): { entries: VisibleNode[]; tail: VisibleNode } {
  const entries: VisibleNode[] = [start];
  let tail = start;

  while (tail.children.length === 1) {
    const next = tail.children[0]!;
    entries.push(next);
    tail = next;
  }

  return { entries, tail };
}

function heuristicLabelForEntry(entry: VisibleEntry): string {
  if (entry.type === "branch_summary") {
    return shortWords(entry.summary || "Branch summary");
  }
  if (entry.type === "compaction") {
    return shortWords(entry.summary || "Compacted context");
  }

  const text = extractTextBlocks(entry.message.content).join(" ").trim();
  if (text) return shortWords(text);

  const toolNames = extractToolCallNames(entry.message.content);
  if (toolNames.length > 0) return shortWords(`Run ${toolNames.join(" ")}`);

  return entry.message.role === "assistant" ? "Assistant step" : "User turn";
}

function heuristicLabelForBranch(entries: VisibleNode[]): string {
  const firstUser = entries.find((entry) => getMessageRole(entry.entry) === "user");
  if (firstUser) return heuristicLabelForEntry(firstUser.entry);

  const firstAssistant = entries.find((entry) => getMessageRole(entry.entry) === "assistant");
  if (firstAssistant) return heuristicLabelForEntry(firstAssistant.entry);

  const special = entries.find((entry) => isSpecialEntry(entry.entry));
  if (special) return heuristicLabelForEntry(special.entry);

  return "Conversation branch";
}

function buildBranches(reader: SessionReader): BranchNode[] {
  const roots = buildVisibleTree(reader);
  const activeIds = activeVisibleIds(reader);
  const activeLeafId = activeVisibleLeafId(reader);

  const buildBranch = (start: VisibleNode): BranchNode => {
    const { entries, tail } = collectBranchEntries(start);
    const labels = labelsForEntries(reader, entries);
    const children = tail.children.map(buildBranch);
    const startId = entries[0]!.id;
    const endId = entries[entries.length - 1]!.id;
    const userCount = entries.filter((entry) => entry.entry.type === "message" && entry.entry.message.role === "user").length;
    const assistantCount = entries.filter((entry) => entry.entry.type === "message" && entry.entry.message.role === "assistant").length;
    const toolCallCount = entries.reduce((total, entry) => {
      if (entry.entry.type !== "message" || entry.entry.message.role !== "assistant") return total;
      return total + countToolCalls(entry.entry.message.content);
    }, 0);
    const textWordCount = entries.reduce((total, entry) => {
      if (entry.entry.type === "branch_summary") return total + words(entry.entry.summary).length;
      if (entry.entry.type === "compaction") return total + words(entry.entry.summary).length;
      return total + countTextWords(entry.entry.message.content);
    }, 0);
    const startedAt = entries[0]!.entry.timestamp;
    const endedAt = entries[entries.length - 1]!.entry.timestamp;

    return {
      id: `${startId}..${endId}`,
      startId,
      endId,
      entries,
      children,
      heuristicLabel: heuristicLabelForBranch(entries),
      hasLabel: labels.length > 0,
      labels,
      active: entries.some((entry) => activeIds.has(entry.id)),
      activeLeaf: activeLeafId !== null && entries.some((entry) => entry.id === activeLeafId),
      branchSummaryCount: entries.filter((entry) => entry.entry.type === "branch_summary").length,
      compactionCount: entries.filter((entry) => entry.entry.type === "compaction").length,
      userCount,
      assistantCount,
      toolCallCount,
      textWordCount,
      startedAt,
      endedAt,
    };
  };

  return roots.map(buildBranch);
}

function flattenBranches(roots: BranchNode[]): FlatBranchRow[] {
  const rows: FlatBranchRow[] = [];

  const walk = (branch: BranchNode, ancestorsHasMore: boolean[], isLast: boolean, depth: number) => {
    rows.push({ branch, ancestorsHasMore, isLast, depth });
    branch.children.forEach((child, index) => {
      walk(child, [...ancestorsHasMore, !isLast], index === branch.children.length - 1, depth + 1);
    });
  };

  roots.forEach((root, index) => walk(root, [], index === roots.length - 1, 0));
  return rows;
}

function buildTreeseeData(reader: SessionReader): TreeseeData {
  const roots = buildBranches(reader);
  return {
    roots,
    flatRows: flattenBranches(roots),
    sessionName: reader.getSessionName(),
    sessionFile: reader.getSessionFile(),
    cwd: reader.getCwd(),
    activeLeafId: activeVisibleLeafId(reader),
  };
}

function branchLabel(branch: BranchNode): string {
  return branch.llmLabel?.trim() || branch.heuristicLabel;
}

function buildBranchContentForSummary(branch: BranchNode): string {
  const specialLines: string[] = [];
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  const toolCallNames = new Set<string>();

  for (const entryNode of branch.entries) {
    const entry = entryNode.entry;
    if (entry.type === "branch_summary") {
      specialLines.push(`Branch summary: ${summarizeSnippet(entry.summary, 60)}`);
      continue;
    }
    if (entry.type === "compaction") {
      specialLines.push(`Compaction summary: ${summarizeSnippet(entry.summary, 60)}`);
      continue;
    }

    const text = extractTextBlocks(entry.message.content).join(" ").trim();
    const toolNames = extractToolCallNames(entry.message.content);
    for (const toolName of toolNames) toolCallNames.add(toolName);

    if (entry.message.role === "user") {
      if (text) userTexts.push(text);
      continue;
    }

    if (text) {
      assistantTexts.push(text);
    }
  }

  const lines: string[] = [];
  for (const line of specialLines) {
    lines.push(line);
  }

  const firstUser = userTexts[0];
  const lastUser = userTexts[userTexts.length - 1];
  if (firstUser) {
    lines.push(`First user request: ${summarizeSnippet(firstUser, 40)}`);
  }
  if (lastUser && lastUser !== firstUser) {
    lines.push(`Latest user request: ${summarizeSnippet(lastUser, 40)}`);
  }

  if (toolCallNames.size > 0) {
    lines.push(`Assistant tool calls: ${[...toolCallNames].slice(0, 12).join(", ")}`);
  }

  if (userTexts.length === 0) {
    const firstAssistant = assistantTexts[0];
    const lastAssistant = assistantTexts[assistantTexts.length - 1];
    if (firstAssistant) {
      lines.push(`First assistant reply: ${summarizeSnippet(firstAssistant, 40)}`);
    }
    if (lastAssistant && lastAssistant !== firstAssistant) {
      lines.push(`Latest assistant reply: ${summarizeSnippet(lastAssistant, 40)}`);
    }
  } else if (toolCallNames.size === 0) {
    const lastAssistant = assistantTexts[assistantTexts.length - 1];
    if (lastAssistant) {
      lines.push(`Latest assistant reply: ${summarizeSnippet(lastAssistant, 30)}`);
    }
  }

  return lines.join("\n\n");
}

function cacheKey(sessionFile: string | undefined, model: Model<any>, branch: BranchNode, contentHash: string): string {
  const sessionPart = sessionFile ?? "<in-memory>";
  return [sessionPart, `${model.provider}/${model.id}`, branch.id, contentHash].join("::");
}

async function loadSummaryCache(): Promise<SummaryCacheFile> {
  if (summaryCache) return summaryCache;

  try {
    const content = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(content) as SummaryCacheFile;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      summaryCache = parsed;
      return summaryCache;
    }
  } catch {
    // ignore
  }

  summaryCache = { version: 1, entries: {} };
  return summaryCache;
}

async function saveSummaryCache(): Promise<void> {
  if (!summaryCache) return;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(summaryCache, null, 2), "utf8");
}

function sanitizeSummaryLabel(raw: string): string {
  return shortWords(raw.replace(/^['"`]+|['"`]+$/g, "").trim());
}

type AutoSummarizer = {
  model: Model<any>;
  apiKey: string;
};

async function prepareAutoSummarizer(ctx: ExtensionCommandContext): Promise<AutoSummarizer | { reason: string }> {
  if (!ctx.model) {
    return { reason: "Auto-summary unavailable: no current model selected" };
  }

  const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
  if (!apiKey) {
    return { reason: `Auto-summary unavailable: no API key for ${ctx.model.provider}/${ctx.model.id}` };
  }

  return { model: ctx.model, apiKey };
}

async function summarizeBranchWithPreparedModel(
  branch: BranchNode,
  data: TreeseeData,
  summarizer: AutoSummarizer,
): Promise<string | null> {
  const content = buildBranchContentForSummary(branch);
  if (!content.trim()) {
    return null;
  }

  const contentHash = hashText(content);
  const cache = await loadSummaryCache();
  const key = cacheKey(data.sessionFile, summarizer.model, branch, contentHash);
  const cached = cache.entries[key];
  if (cached?.summary) return cached.summary;

  const response = await complete(
    summarizer.model,
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Summarize this conversation tree branch in 4 or 5 words maximum.",
                "Return only the label.",
                "No bullets. No quotes. No markdown. No trailing punctuation.",
                "Prefer the concrete intent or outcome.",
                "",
                "<branch>",
                content,
                "</branch>",
              ].join("\n"),
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey: summarizer.apiKey },
  );

  const summary = sanitizeSummaryLabel(
    response.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join(" "),
  );

  if (!summary.trim()) return null;

  cache.entries[key] = { summary, updatedAt: new Date().toISOString() };
  await saveSummaryCache();
  return summary;
}

class SessionSelectorComponent implements Component {
  private sessions: SessionInfo[];
  private currentSessionPath?: string;
  private theme: ThemeLike;
  private selectedIndex: number;
  private done: (session: SessionInfo | null) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(sessions: SessionInfo[], currentSessionPath: string | undefined, theme: ThemeLike, done: (session: SessionInfo | null) => void) {
    this.sessions = sessions;
    this.currentSessionPath = currentSessionPath;
    this.theme = theme;
    this.done = done;
    this.selectedIndex = sessions.findIndex((session) => session.path === currentSessionPath);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
      this.done(null);
      return;
    }

    if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      this.selectedIndex = Math.min(this.sessions.length - 1, this.selectedIndex + 1);
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.done(this.sessions[this.selectedIndex] ?? null);
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
    container.addChild(new Spacer(1));
    container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Select session")), 1, 0));
    container.addChild(new Text(this.theme.fg("dim", `${rawKeyHint("↑↓", "navigate")}  ${keyHint("selectConfirm", "open")}  ${keyHint("selectCancel", "cancel")}`), 1, 0));
    container.addChild(new Spacer(1));

    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(SESSION_LIST_WINDOW / 2), Math.max(0, this.sessions.length - SESSION_LIST_WINDOW)));
    const end = Math.min(this.sessions.length, start + SESSION_LIST_WINDOW);

    for (let index = start; index < end; index++) {
      const session = this.sessions[index]!;
      const selected = index === this.selectedIndex;
      const current = session.path === this.currentSessionPath;
      const title = session.name?.trim() || shortWords(session.firstMessage || path.basename(session.path), 6);
      const left = `${selected ? "→" : " "} ${title}`;
      const right = `${session.messageCount} msgs · ${session.modified.toISOString().slice(0, 10)}${current ? " · current" : ""}`;
      let line = left;
      const available = Math.max(1, width - 4);
      const leftWidth = Math.max(10, available - visibleWidth(right) - 2);
      line = truncateToWidth(left, leftWidth);
      line = line + "  " + padLeftVisible(this.theme.fg("muted", right), Math.max(0, available - visibleWidth(line) - 2));
      line = truncateToWidth(line, available);
      const padded = padRightVisible(line, available);
      const styled = selected ? this.theme.bg("selectedBg", padded) : padded;
      container.addChild(new Text(styled, 1, 0));
      container.addChild(new Text(this.theme.fg("dim", abbreviatePath(session.cwd, Math.max(20, available - 2))), 3, 0));
    }

    if (this.sessions.length === 0) {
      container.addChild(new Text(this.theme.fg("warning", "No sessions found"), 1, 0));
    }

    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));

    this.cachedWidth = width;
    this.cachedLines = container.render(width).map((line) => truncateToWidth(line, width));
    return this.cachedLines;
  }
}

async function autoSummarizeBranches(
  data: TreeseeData,
  ctx: ExtensionCommandContext,
): Promise<{ success: boolean; warning?: string }> {
  const prepared = await prepareAutoSummarizer(ctx);
  if (!("model" in prepared)) {
    return { success: false, warning: prepared.reason };
  }

  const branches = data.flatRows.map((row) => row.branch);
  if (branches.length === 0) return { success: true };

  let failureMessage: string | undefined;

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, `Summarizing 0/${branches.length} branches...`, {
      cancellable: false,
    });

    const inner = (loader as unknown as { loader?: { setMessage?: (message: string) => void } }).loader;
    const setMessage = (message: string) => {
      inner?.setMessage?.(message);
    };

    (async () => {
      for (let index = 0; index < branches.length; index++) {
        const branch = branches[index]!;
        setMessage(`Summarizing ${index + 1}/${branches.length}: ${branchLabel(branch)}`);
        const summary = await summarizeBranchWithPreparedModel(branch, data, prepared);
        if (summary) {
          branch.llmLabel = summary;
        }
      }
      done();
    })().catch((error) => {
      console.error("treesee: failed to auto-summarize branches", error);
      failureMessage = error instanceof Error ? error.message : String(error);
      done();
    });

    return loader;
  });

  return failureMessage
    ? { success: false, warning: `Auto-summary failed: ${failureMessage}` }
    : { success: true };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function branchDurationLabel(branch: BranchNode): string {
  const start = new Date(branch.startedAt).getTime();
  const end = new Date(branch.endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";

  const minutes = Math.round((end - start) / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  if (hours < 24) return `${hours}h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days}d`;
}

type HtmlBranchNode = {
  id: string;
  label: string;
  active: boolean;
  activeLeaf: boolean;
  labels: string[];
  branchSummaryCount: number;
  compactionCount: number;
  userCount: number;
  assistantCount: number;
  toolCallCount: number;
  textWordCount: number;
  startedAt: string;
  endedAt: string;
  durationLabel: string;
  children: HtmlBranchNode[];
};

function toHtmlBranchNode(branch: BranchNode): HtmlBranchNode {
  return {
    id: branch.id,
    label: branchLabel(branch),
    active: branch.active,
    activeLeaf: branch.activeLeaf,
    labels: branch.labels,
    branchSummaryCount: branch.branchSummaryCount,
    compactionCount: branch.compactionCount,
    userCount: branch.userCount,
    assistantCount: branch.assistantCount,
    toolCallCount: branch.toolCallCount,
    textWordCount: branch.textWordCount,
    startedAt: branch.startedAt,
    endedAt: branch.endedAt,
    durationLabel: branchDurationLabel(branch),
    children: branch.children.map(toHtmlBranchNode),
  };
}

function renderTreeseeHtml(data: TreeseeData): string {
  const payload = {
    sessionName: data.sessionName ?? abbreviatePath(data.sessionFile ?? data.cwd, 80),
    sessionFile: data.sessionFile ?? data.cwd,
    roots: data.roots.map(toHtmlBranchNode),
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(payload.sessionName)} · treesee</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    html, body {
      margin: 0;
      background: #080c12;
      color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 24px;
      gap: 16px;
    }

    /* dot grid */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: radial-gradient(circle, rgba(255,255,255,.055) 1px, transparent 1px);
      background-size: 28px 28px;
      pointer-events: none;
      z-index: 0;
    }

    /* ambient glow */
    body::after {
      content: '';
      position: fixed;
      top: -25%;
      left: 50%;
      transform: translateX(-50%);
      width: 80vw;
      height: 55vh;
      background: radial-gradient(ellipse, rgba(88,166,255,.055) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    header {
      position: relative;
      z-index: 1;
    }

    .session-name {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -.02em;
      color: #e6edf3;
      margin: 0 0 4px;
    }

    .session-path {
      font-size: 11.5px;
      color: #6e7681;
      margin: 0;
      font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
    }

    .viewport {
      position: relative;
      z-index: 1;
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 16px;
      background: rgba(8,12,18,.65);
      overflow: auto;
      flex: 1;
      min-height: 200px;
      box-shadow: 0 1px 0 rgba(255,255,255,.05) inset;
    }

    .canvas { position: relative; }

    svg.edges {
      position: absolute;
      inset: 0;
      overflow: visible;
      pointer-events: none;
    }

    /* ── node card ─────────────────────────────────────────── */
    .node {
      position: absolute;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(16,22,34,.92);
      box-shadow:
        0 1px 0 rgba(255,255,255,.06) inset,
        0 6px 20px rgba(0,0,0,.45);
      padding: 12px 14px;
      cursor: default;
      transition: border-color .15s, box-shadow .15s, transform .15s;
      will-change: transform;
    }

    .node:hover {
      transform: translateY(-1px);
      box-shadow:
        0 1px 0 rgba(255,255,255,.08) inset,
        0 10px 28px rgba(0,0,0,.55);
    }

    .node.active-path {
      border-color: rgba(88,166,255,.38);
      box-shadow:
        0 1px 0 rgba(255,255,255,.06) inset,
        0 0 0 1px rgba(88,166,255,.1),
        0 6px 20px rgba(0,0,0,.45);
    }

    .node.active-path:hover {
      box-shadow:
        0 1px 0 rgba(255,255,255,.08) inset,
        0 0 0 1px rgba(88,166,255,.15),
        0 10px 28px rgba(0,0,0,.5),
        0 0 18px rgba(88,166,255,.07);
    }

    .node.active-leaf {
      border-color: rgba(63,185,80,.48);
      box-shadow:
        0 1px 0 rgba(255,255,255,.06) inset,
        0 0 0 1px rgba(63,185,80,.15),
        0 6px 20px rgba(0,0,0,.45),
        0 0 24px rgba(63,185,80,.09);
    }

    .node.active-leaf:hover {
      box-shadow:
        0 1px 0 rgba(255,255,255,.08) inset,
        0 0 0 1px rgba(63,185,80,.2),
        0 10px 28px rgba(0,0,0,.5),
        0 0 30px rgba(63,185,80,.13);
    }

    .node-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 9px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 3px;
    }

    .dot.idle   { background: #3a434f; }
    .dot.active { background: #58a6ff; box-shadow: 0 0 6px rgba(88,166,255,.5); }
    .dot.leaf   { background: #3fb950; box-shadow: 0 0 6px rgba(63,185,80,.5); }

    .node-title {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.3;
      color: #e6edf3;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .node.active-path .node-title { color: #b8d4f8; }
    .node.active-leaf .node-title { color: #9ed6a7; }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      line-height: 1.4;
      white-space: nowrap;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.07);
      color: #6e7681;
    }

    .badge.turns  { color: #c9d1d9; }
    .badge.tools  { color: #a5b4fc; }
    .badge.words  { color: #7d8590; }
    .badge.dur    { color: #fcd34d; }
    .badge.bs     { color: #b28ef8; border-color: rgba(178,142,248,.2); background: rgba(178,142,248,.06); }
    .badge.comp   { color: #e3b341; border-color: rgba(227,179,65,.2);  background: rgba(227,179,65,.06);  }
    .badge.s-leaf { color: #86efac; border-color: rgba(63,185,80,.25);  background: rgba(63,185,80,.07);   }
    .badge.s-path { color: #93c5fd; border-color: rgba(88,166,255,.2);  background: rgba(88,166,255,.06);  }
    .badge.lbl    { color: #fbbf24; border-color: rgba(251,191,36,.2);  background: rgba(251,191,36,.06);  }

    /* ── tooltip ───────────────────────────────────────────── */
    #tooltip {
      position: fixed;
      z-index: 9999;
      pointer-events: none;
      background: rgba(11,15,24,.97);
      border: 1px solid rgba(255,255,255,.11);
      border-radius: 11px;
      padding: 12px 14px;
      min-width: 200px;
      max-width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,.65), 0 1px 0 rgba(255,255,255,.05) inset;
      font-size: 12px;
      line-height: 1.5;
    }

    #tooltip[hidden] { display: none !important; }

    .tt-title {
      font-weight: 700;
      font-size: 13px;
      color: #e6edf3;
      margin-bottom: 8px;
      line-height: 1.3;
    }

    .tt-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 3px 0;
      border-top: 1px solid rgba(255,255,255,.05);
    }

    .tt-row span:first-child { color: #6e7681; }
    .tt-row span:last-child  { color: #c9d1d9; font-variant-numeric: tabular-nums; }

    .tt-state {
      margin-top: 8px;
      font-size: 10.5px;
      padding: 2px 9px;
      border-radius: 999px;
      display: inline-block;
      background: rgba(255,255,255,.05);
      color: #6e7681;
    }

    .tt-state.active-path { background: rgba(88,166,255,.12); color: #93c5fd; border: 1px solid rgba(88,166,255,.2); }
    .tt-state.active-leaf { background: rgba(63,185,80,.12);  color: #86efac; border: 1px solid rgba(63,185,80,.2);  }

    /* ── legend ────────────────────────────────────────────── */
    .legend {
      position: relative;
      z-index: 1;
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      font-size: 11.5px;
      color: #6e7681;
    }

    .legend-item { display: flex; align-items: center; gap: 6px; }
    .legend-dot  { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  </style>
</head>
<body>
  <header>
    <h1 class="session-name">${escapeHtml(payload.sessionName)}</h1>
    <p class="session-path">${escapeHtml(payload.sessionFile)}</p>
  </header>

  <div class="viewport">
    <div id="canvas" class="canvas"></div>
  </div>

  <div class="legend">
    <div class="legend-item">
      <span class="legend-dot" style="background:#3fb950;box-shadow:0 0 5px rgba(63,185,80,.55)"></span>
      <span>Active leaf</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background:#58a6ff;box-shadow:0 0 5px rgba(88,166,255,.55)"></span>
      <span>On active path</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background:#3a434f"></span>
      <span>Idle branch</span>
    </div>
  </div>

  <div id="tooltip" hidden></div>

  <script>
    const data = ${JSON.stringify(payload)};

    // ── constants ──────────────────────────────────────────
    const NODE_W = 224;
    const X_GAP  = 40;   // gap between sibling subtrees
    const Y_GAP  = 60;   // vertical gap between depth levels
    const H_PAD  = 48;   // canvas left/right padding
    const V_PAD  = 48;   // canvas top/bottom padding

    // ── node height from badge count ───────────────────────
    function nodeH(n) {
      const cnt = [
        true,                             // turns (always)
        n.toolCallCount > 0,
        true,                             // words (always)
        !!n.durationLabel,
        n.branchSummaryCount > 0,
        n.compactionCount > 0,
        n.activeLeaf || n.active,
        n.labels && n.labels.length > 0,
      ].filter(Boolean).length;
      return Math.max(88, 71 + Math.ceil(cnt / 3) * 25);
    }

    // ── subtree width (post-order) ─────────────────────────
    function subW(n) {
      n.w = NODE_W;
      n.h = nodeH(n);
      if (!n.children.length) { n.sw = NODE_W; return; }
      n.children.forEach(subW);
      const cw = n.children.reduce((s, c) => s + c.sw, 0) + X_GAP * (n.children.length - 1);
      n.sw = Math.max(NODE_W, cw);
    }

    // ── per-depth max heights ──────────────────────────────
    function maxDepthH(roots) {
      const m = {};
      const walk = (n, d) => {
        m[d] = Math.max(m[d] || 0, n.h);
        n.children.forEach(c => walk(c, d + 1));
      };
      roots.forEach(r => walk(r, 0));
      return m;
    }

    function depthOffsets(depthH) {
      const off = {};
      let y = V_PAD;
      Object.keys(depthH).map(Number).sort((a, b) => a - b).forEach(d => {
        off[d] = y;
        y += depthH[d] + Y_GAP;
      });
      return off;
    }

    // ── x/y positions (pre-order) ──────────────────────────
    function pos(n, d, lx, dOff) {
      n.x = lx + (n.sw - NODE_W) / 2;
      n.y = dOff[d] !== undefined ? dOff[d] : V_PAD;
      if (!n.children.length) return;
      const cw = n.children.reduce((s, c) => s + c.sw, 0) + X_GAP * (n.children.length - 1);
      let cx = lx + (n.sw - cw) / 2;
      n.children.forEach(c => { pos(c, d + 1, cx, dOff); cx += c.sw + X_GAP; });
    }

    // ── run layout ─────────────────────────────────────────
    const all = [];
    const flatten = n => { all.push(n); n.children.forEach(flatten); };
    data.roots.forEach(r => { subW(r); flatten(r); });

    const dH   = maxDepthH(data.roots);
    const dOff = depthOffsets(dH);

    let rlx = H_PAD;
    data.roots.forEach(r => {
      pos(r, 0, rlx, dOff);
      rlx += r.sw + X_GAP * 2;
    });

    const cw = all.reduce((m, n) => Math.max(m, n.x + NODE_W), 0) + H_PAD;
    const ch = all.reduce((m, n) => Math.max(m, n.y + n.h),    0) + V_PAD;

    const canvas = document.getElementById('canvas');
    canvas.style.width  = cw + 'px';
    canvas.style.height = ch + 'px';

    // ── SVG edges ──────────────────────────────────────────
    const NS  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'edges');
    svg.setAttribute('width', cw);
    svg.setAttribute('height', ch);
    svg.setAttribute('viewBox', '0 0 ' + cw + ' ' + ch);
    canvas.appendChild(svg);

    all.forEach(n => {
      n.children.forEach(c => {
        // vertical S-curve: bottom-centre of parent → top-centre of child
        const x1 = n.x + NODE_W / 2;
        const y1 = n.y + n.h;
        const x2 = c.x + NODE_W / 2;
        const y2 = c.y;
        const my = (y1 + y2) / 2;

        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d',
          'M ' + x1 + ' ' + y1 +
          ' C ' + x1 + ' ' + my + ', ' + x2 + ' ' + my + ', ' + x2 + ' ' + y2);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke-linecap', 'round');

        if (c.activeLeaf) {
          p.setAttribute('stroke', '#3fb950');
          p.setAttribute('stroke-width', '2.5');
          p.setAttribute('opacity', '0.9');
        } else if (c.active || n.active) {
          p.setAttribute('stroke', '#58a6ff');
          p.setAttribute('stroke-width', '2');
          p.setAttribute('opacity', '0.7');
        } else {
          p.setAttribute('stroke', '#222c3a');
          p.setAttribute('stroke-width', '1.5');
          p.setAttribute('opacity', '0.85');
        }
        svg.appendChild(p);
      });
    });

    // ── node cards ─────────────────────────────────────────
    function mkdiv(cls) {
      const el = document.createElement('div');
      el.className = cls;
      return el;
    }

    function badge(text, cls) {
      const s = document.createElement('span');
      s.className = 'badge' + (cls ? ' ' + cls : '');
      s.textContent = text;
      return s;
    }

    function esc(t) {
      return String(t)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    all.forEach(n => {
      const el = mkdiv('node' + (n.activeLeaf ? ' active-leaf' : n.active ? ' active-path' : ''));
      el.style.left   = n.x + 'px';
      el.style.top    = n.y + 'px';
      el.style.width  = NODE_W + 'px';
      el.style.height = n.h + 'px';

      // tooltip data-attribute
      el.dataset.tt = JSON.stringify({
        label:   n.label,
        user:    n.userCount,
        assist:  n.assistantCount,
        tools:   n.toolCallCount,
        words:   n.textWordCount,
        dur:     n.durationLabel || '',
        labels:  n.labels || [],
        started: n.startedAt ? new Date(n.startedAt).toLocaleString() : '',
        state:   n.activeLeaf ? 'active-leaf' : n.active ? 'active-path' : '',
        stateLabel: n.activeLeaf ? 'active leaf' : n.active ? 'on active path' : 'idle branch',
      });

      // header: dot + title
      const hdr   = mkdiv('node-header');
      const dot   = mkdiv('dot ' + (n.activeLeaf ? 'leaf' : n.active ? 'active' : 'idle'));
      const title = mkdiv('node-title');
      title.textContent = n.label;
      hdr.appendChild(dot);
      hdr.appendChild(title);
      el.appendChild(hdr);

      // badges
      const bg = mkdiv('badges');
      bg.appendChild(badge((n.userCount + n.assistantCount) + ' turns', 'turns'));
      if (n.toolCallCount > 0)       bg.appendChild(badge(n.toolCallCount + ' tools', 'tools'));
      bg.appendChild(badge(n.textWordCount + ' words', 'words'));
      if (n.durationLabel)           bg.appendChild(badge(n.durationLabel, 'dur'));
      if (n.branchSummaryCount > 0)  bg.appendChild(badge('summary×' + n.branchSummaryCount, 'bs'));
      if (n.compactionCount > 0)     bg.appendChild(badge('compact×' + n.compactionCount, 'comp'));
      if (n.activeLeaf)              bg.appendChild(badge('active', 's-leaf'));
      else if (n.active)             bg.appendChild(badge('on path', 's-path'));
      if (n.labels && n.labels.length > 0) {
        n.labels.slice(0, 2).forEach(l => bg.appendChild(badge('#' + l, 'lbl')));
      }
      el.appendChild(bg);

      canvas.appendChild(el);
    });

    // ── tooltip ────────────────────────────────────────────
    const tooltip = document.getElementById('tooltip');

    document.addEventListener('mousemove', e => {
      const node = e.target.closest('.node');
      if (!node || !node.dataset.tt) { tooltip.hidden = true; return; }

      const d = JSON.parse(node.dataset.tt);
      tooltip.hidden = false;
      tooltip.innerHTML =
        '<div class="tt-title">' + esc(d.label) + '</div>' +
        '<div class="tt-row"><span>User / assistant</span><span>' + d.user + ' / ' + d.assist + '</span></div>' +
        (d.tools > 0 ? '<div class="tt-row"><span>Tool calls</span><span>' + d.tools + '</span></div>' : '') +
        '<div class="tt-row"><span>Words</span><span>' + d.words + '</span></div>' +
        (d.dur ? '<div class="tt-row"><span>Duration</span><span>' + esc(d.dur) + '</span></div>' : '') +
        (d.started ? '<div class="tt-row"><span>Started</span><span>' + esc(d.started) + '</span></div>' : '') +
        (d.labels.length ? '<div class="tt-row"><span>Labels</span><span>' + esc(d.labels.join(', ')) + '</span></div>' : '') +
        '<div style="margin-top:8px"><span class="tt-state ' + esc(d.state) + '">' + esc(d.stateLabel) + '</span></div>';

      const pad = 12, tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      let tx = e.clientX + 14, ty = e.clientY - 10;
      if (tx + tw + pad > vw) tx = e.clientX - tw - 14;
      if (ty + th + pad > vh) ty = e.clientY - th + 10;
      tooltip.style.left = Math.max(pad, tx) + 'px';
      tooltip.style.top  = Math.max(pad, ty) + 'px';
    });

    document.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  </script>
</body>
</html>`;
}

export function renderSessionFileHtml(sessionFile: string): string {
  const reader = SessionManager.open(sessionFile);
  const data = buildTreeseeData(reader);
  return renderTreeseeHtml(data);
}

async function openHtmlFile(filePath: string, pi: ExtensionAPI): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await pi.exec("open", [filePath]);
      return;
    }
    if (process.platform === "win32") {
      await pi.exec("cmd", ["/c", "start", "", filePath]);
      return;
    }
    await pi.exec("xdg-open", [filePath]);
  } catch {
    // Ignore launcher failures; caller will still get the file path.
  }
}

async function chooseSession(
  ctx: ExtensionCommandContext,
): Promise<SessionInfo | null> {
  const data = await ctx.ui.custom<SessionInfo[] | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(
      tui,
      theme,
      "Loading sessions...",
      { cancellable: false },
    );

    SessionManager.listAll()
      .then((sessions) => {
        const sorted = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
        done(sorted);
      })
      .catch((error) => {
      console.error("treesee: failed to load sessions", error);
        done(null);
      });

    return loader;
  });

  if (!data) return null;
  if (data.length === 0) {
    ctx.ui.notify("No sessions found", "warning");
    return null;
  }

  return ctx.ui.custom<SessionInfo | null>((_tui, theme, _kb, done) => {
    return new SessionSelectorComponent(data, ctx.sessionManager.getSessionFile(), theme, done);
  });
}

function parseModeAndTarget(args: string): { mode: "current" | "open" | "path" | "invalid"; path?: string; raw?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { mode: "current" };
  if (trimmed === "open") return { mode: "open" };
  if (trimmed.endsWith(".jsonl") || trimmed.startsWith("/") || trimmed.startsWith("~")) {
    const resolved = trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
    return { mode: "path", path: resolved };
  }
  return { mode: "invalid", raw: trimmed };
}

async function openReaderForArgs(args: string, ctx: ExtensionCommandContext): Promise<SessionReader | null> {
  const parsed = parseModeAndTarget(args);

  if (parsed.mode === "current") return ctx.sessionManager;

  if (parsed.mode === "open") {
    const selected = await chooseSession(ctx);
    if (!selected) return null;
    return SessionManager.open(selected.path);
  }

  if (parsed.mode === "invalid") {
    throw new Error(`Unknown treesee argument: ${parsed.raw}. Use /treesee, /treesee open, or /treesee /path/to/session.jsonl`);
  }

  if (parsed.mode === "path" && parsed.path) {
    return SessionManager.open(parsed.path);
  }

  return ctx.sessionManager;
}

export default function treeseeExtension(pi: ExtensionAPI) {
  pi.registerCommand("treesee", {
    description: "Open the current or selected pi session as a polished HTML conversation tree",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        pi.sendMessage(
          {
            customType: "treesee",
            content: "treesee requires interactive mode",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      let reader: SessionReader | null = null;
      try {
        reader = await openReaderForArgs(args, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (!reader) return;

      const data = buildTreeseeData(reader);
      if (data.flatRows.length === 0) {
        ctx.ui.notify("No visible conversation tree found for this session", "warning");
        return;
      }

      const summarizeResult = await autoSummarizeBranches(data, ctx);
      if (!summarizeResult.success && summarizeResult.warning) {
        ctx.ui.notify(summarizeResult.warning, "warning");
      }

      const html = renderTreeseeHtml(data);
      const fileId = hashText(`${data.sessionFile ?? data.cwd}:${data.flatRows.map((row) => row.branch.id).join("|")}`);
      const htmlPath = path.join(os.tmpdir(), `pi-treesee-${fileId}.html`);
      await fs.writeFile(htmlPath, html, "utf8");
      await openHtmlFile(htmlPath, pi);
      ctx.ui.notify(`Opened treesee HTML: ${htmlPath}`, "info");
    },
  });
}
