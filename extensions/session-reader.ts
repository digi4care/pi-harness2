import * as fs from "node:fs";
import * as path from "node:path";
import type { HostInfo } from "./host-detector.js";
import type { FrictionPoint, HostType, TimelineEvent, ToolExecutionRecord } from "./types.js";

export interface SessionData {
  timeline: TimelineEvent[];
  records: ToolExecutionRecord[];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        Boolean(b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string"),
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// Session directory resolution is stable per (root, cwd) but the full scan walks
// every session directory on the machine. Cache the resolved directory so repeat
// invocations (every agent cycle) only list files inside it.
const sessionDirCache = new Map<string, string>();

// Parsed-session state, keyed by file path. Session recordings are append-only,
// so re-diagnosis only parses newly appended bytes and returns the cumulative
// tail-window events — a per-cycle read costs kilobytes instead of a fresh 4MB scan.
interface ParsedEntry {
  bytes: number;
  timeline?: TimelineEvent;
  record?: ToolExecutionRecord;
}

interface SessionParseState {
  entries: ParsedEntry[];
  totalBytes: number;
  offset: number;
  aligned: boolean;
}

const sessionParseCache = new Map<string, SessionParseState>();
const MAX_PARSE_CACHE_ENTRIES = 8;

function readBytesFrom(file: string, start: number, length: number): string {
  if (length <= 0) return "";
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, bytes).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseSessionHeader(head: string): { cwd?: string; id?: string; timestamp?: string } | undefined {
  const sessionLine = head.split("\n").find((l) => l.includes('"type":"session"'));
  if (!sessionLine) return undefined;
  try {
    return JSON.parse(sessionLine) as { cwd?: string; id?: string; timestamp?: string };
  } catch {
    return undefined;
  }
}

function readSessionLine(file: string): { cwd?: string; id?: string; timestamp?: string } | undefined {
  try {
    const fd = fs.openSync(file, "r");
    let bytes: number;
    const buf = Buffer.alloc(8192);
    try {
      bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return parseSessionHeader(buf.subarray(0, bytes).toString("utf-8"));
  } catch {
    return undefined;
  }
}

// Header read from an already-open descriptor: the snapshot reader must verify
// identity against the very inode it will consume, not against a second open
// of the path (which could resolve to a replaced file).
function readSessionHeaderFromFd(fd: number): { cwd?: string; id?: string; timestamp?: string } | undefined {
  try {
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    return parseSessionHeader(buf.subarray(0, bytes).toString("utf-8"));
  } catch {
    return undefined;
  }
}

function newestMatchingFileInDir(dirPath: string, wantCwd: string): { file: string; mtimeMs: number } | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  // Newest filename first: "<ISO-ts>_<sessionId>.jsonl" sorts chronologically
  files.sort().reverse();
  for (const name of files) {
    const file = path.join(dirPath, name);
    const header = readSessionLine(file);
    if (!header || typeof header.cwd !== "string") continue;
    let recCwd: string;
    try {
      recCwd = fs.realpathSync(header.cwd);
    } catch {
      recCwd = path.resolve(header.cwd);
    }
    if (recCwd !== wantCwd) continue;
    try {
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Locate the newest host session recording (`<userConfigDir>/sessions/<encoded-cwd>/*.jsonl`)
 * whose header `session.cwd` matches the given cwd. Hosts encode the directory name
 * differently (pi vs omp), so we match on the recorded cwd field instead of the path.
 */
export function findSessionFile(hostInfo: HostInfo, cwd: string): string | undefined {
  const root = process.env.PI_HARNESS_SESSIONS_ROOT ?? path.join(hostInfo.userConfigDir, "sessions");
  // Normalize once: hosts may record cwd with different symlink/trailing-slash spelling
  let wantCwd: string;
  try {
    wantCwd = fs.realpathSync(cwd);
  } catch {
    wantCwd = path.resolve(cwd);
  }

  const cacheKey = `${root}|${wantCwd}`;
  const cachedDir = sessionDirCache.get(cacheKey);
  if (cachedDir) {
    const hit = newestMatchingFileInDir(cachedDir, wantCwd);
    if (hit) return hit.file;
    // Cache miss (session moved or dir removed): fall through to a full rescan.
    sessionDirCache.delete(cacheKey);
  }

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  // Visit recently-active projects first so matches are found near the front.
  const dirInfos: Array<{ name: string; mtimeMs: number }> = [];
  for (const dir of dirs) {
    const dirPath = path.join(root, dir.name);
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) continue; // follows symlinks
      dirInfos.push({ name: dir.name, mtimeMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  dirInfos.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let best: { file: string; mtimeMs: number } | undefined;
  for (const { name } of dirInfos) {
    const hit = newestMatchingFileInDir(path.join(root, name), wantCwd);
    if (hit && (!best || hit.mtimeMs > best.mtimeMs)) {
      best = hit;
      sessionDirCache.set(cacheKey, path.join(root, name));
    }
  }
  return best?.file;
}

const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const PREVIEW_LEN = 500;

/**
 * One discovered session recording for a single explicit host/project scope.
 * Identity is host + normalized project cwd + canonical discovered file path;
 * the host-native session id and recording start timestamp are captured when
 * the recording's first session header provides them.
 */
export interface SessionCatalogEntry {
  /** Host that recorded the session. */
  host: HostType;
  /** Normalized (symlink-resolved) project cwd this recording belongs to. */
  projectCwd: string;
  /** Canonical (symlink-resolved) path of the discovered recording file. */
  filePath: string;
  /** Host-native session id from the recording header, when present. */
  sessionId?: string;
  /** Recording start time in ms since epoch (header timestamp), when present. */
  startedAt?: number;
}

/**
 * Enumerate every valid recording for ONE explicit host/project scope, newest
 * first. Only the given host's session root is scanned (PI_HARNESS_SESSIONS_ROOT
 * overrides it, mirroring findSessionFile) — host roots are never combined, and
 * no session is auto-selected. A file is included only when the cwd recorded in
 * its first session header normalizes to the requested project cwd; directory-
 * name encoding is never trusted as identity. Reads header metadata only —
 * transcript bodies are never parsed here.
 */
export function listSessionRecordings(hostInfo: HostInfo, cwd: string): SessionCatalogEntry[] {
  const root = process.env.PI_HARNESS_SESSIONS_ROOT ?? path.join(hostInfo.userConfigDir, "sessions");
  // Same normalization as findSessionFile: hosts may record cwd with different
  // symlink/trailing-slash spelling.
  let wantCwd: string;
  try {
    wantCwd = fs.realpathSync(cwd);
  } catch {
    wantCwd = path.resolve(cwd);
  }

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: Array<{ entry: SessionCatalogEntry; sortKey: number }> = [];
  for (const dir of dirs) {
    const dirPath = path.join(root, dir.name);
    let files: string[];
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue; // follows symlinks
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(dirPath, name);
      const header = readSessionLine(file);
      if (!header || typeof header.cwd !== "string") continue;
      let recCwd: string;
      try {
        recCwd = fs.realpathSync(header.cwd);
      } catch {
        recCwd = path.resolve(header.cwd);
      }
      if (recCwd !== wantCwd) continue;
      let filePath: string;
      let mtimeMs: number;
      try {
        filePath = fs.realpathSync(file);
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const startedAt = header.timestamp ? Date.parse(header.timestamp) : NaN;
      found.push({
        entry: {
          host: hostInfo.host,
          projectCwd: wantCwd,
          filePath,
          sessionId: typeof header.id === "string" ? header.id : undefined,
          startedAt: Number.isNaN(startedAt) ? undefined : startedAt,
        },
        // Newest-first: header start time when present, file mtime otherwise.
        sortKey: Number.isNaN(startedAt) ? mtimeMs : startedAt,
      });
    }
  }
  found.sort((a, b) => b.sortKey - a.sortKey || a.entry.filePath.localeCompare(b.entry.filePath));
  return found.map((f) => f.entry);
}

/**
 * Parse one complete JSONL line into timeline/record entries. Returns an empty
 * array for lines that are not message entries (or hold no usable content),
 * and undefined for lines that look like message entries but fail JSON.parse —
 * the snapshot reader counts those as unparsed evidence. Pure: no cache, no I/O.
 */
function parseSessionEntryLine(line: string): ParsedEntry[] | undefined {
  const out: ParsedEntry[] = [];
  if (!line.includes('"message"')) return out;
  let entry: { timestamp?: string; message?: Record<string, unknown> };
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const msg = entry.message;
  if (!msg || typeof msg !== "object") return out;
  const ts = entry.timestamp ? Date.parse(entry.timestamp) || Date.now() : Date.now();
  const role = msg.role;
  const bytes = line.length + 1;

  if (role === "user") {
    const text = textOf(msg.content).trim();
    if (text) {
      const ev: TimelineEvent = { timestamp: ts, type: "user_message", content: stripAnsi(text) };
      out.push({ bytes, timeline: ev });
    }
  } else if (role === "assistant") {
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "toolCall") {
        const ev: TimelineEvent = {
          timestamp: ts,
          type: "tool_call",
          toolName: typeof b.name === "string" ? b.name : undefined,
          toolCallId: typeof b.id === "string" ? b.id : undefined,
          // Args feed call→error pairing and success/failure diffs, so keep
          // more than a preview; the diagnostic prompt budget bounds size.
          content: JSON.stringify(b.arguments ?? {}).slice(0, 1000),
        };
        out.push({ bytes, timeline: ev });
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const ev: TimelineEvent = { timestamp: ts, type: "assistant_thought", content: stripAnsi(b.text.trim()) };
        out.push({ bytes, timeline: ev });
      }
    }
  } else if (role === "toolResult") {
    const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
    const isError = Boolean(msg.isError);
    const durationMs = typeof msg.durationMs === "number" ? msg.durationMs : 0;
    const preview = stripAnsi(textOf(msg.content).trim()).slice(0, PREVIEW_LEN) || undefined;
    const rec: ToolExecutionRecord = {
      toolName,
      input: undefined,
      outputPreview: preview,
      isError,
      durationMs,
      timestamp: ts,
    };
    const ev: TimelineEvent = {
      timestamp: ts,
      type: "tool_result",
      toolName,
      toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
      content: preview || (isError ? "Execution failed" : "Execution succeeded"),
      isError,
      durationMs,
    };
    out.push({ bytes, timeline: ev, record: rec });
  }
  return out;
}

/**
 * Parse a host session recording into a Harness² timeline + tool execution records.
 * Format (pi & omp): JSONL, entries `{type:"message", message:{role, content, ...}}`
 * with content blocks `[{type:"text"|"thinking"|"toolCall", ...}]`.
 *
 * Only complete lines are consumed; the parse offset is cached per file, so repeat
 * calls parse just the newly appended bytes and return the cumulative event window
 * (bounded to the most recent MAX_SESSION_BYTES of parsed content). If the file
 * shrank or was replaced, the state resets to a fresh tail read.
 */
export function readSession(hostInfo: HostInfo, cwd: string): SessionData {
  const file = findSessionFile(hostInfo, cwd);
  if (!file) return { timeline: [], records: [] };

  let state = sessionParseCache.get(file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { timeline: [], records: [] };
  }
  if (!state || state.offset > stat.size) {
    state = {
      entries: [],
      totalBytes: 0,
      offset: Math.max(0, stat.size - MAX_SESSION_BYTES),
      aligned: Math.max(0, stat.size - MAX_SESSION_BYTES) === 0,
    };
  }

  try {
    const start = state.offset;
    let raw = readBytesFrom(file, start, stat.size - start);
    let consumed = 0;
    if (!state.aligned) {
      // Mid-file start: drop bytes up to the first complete line boundary
      const nl = raw.indexOf("\n");
      if (nl === -1) {
        state.offset = stat.size;
        state.aligned = true;
        raw = "";
      } else {
        consumed = nl + 1;
        raw = raw.slice(consumed);
        state.aligned = true;
      }
    }
    // Never consume a trailing partial line — it may still be growing
    const lastNl = raw.lastIndexOf("\n");
    const complete = lastNl >= 0 ? raw.slice(0, lastNl + 1) : "";
    state.offset = start + consumed + Buffer.byteLength(complete, "utf-8");

    for (const line of complete.split("\n")) {
      const parsed = parseSessionEntryLine(line);
      if (!parsed) continue;
      for (const p of parsed) {
        state.entries.push(p);
        state.totalBytes += p.bytes;
      }
    }

    // Bound the retained window to the most recent MAX_SESSION_BYTES of parsed lines
    while (state.totalBytes > MAX_SESSION_BYTES && state.entries.length > 1) {
      const dropped = state.entries.shift()!;
      state.totalBytes -= dropped.bytes;
    }

    sessionParseCache.set(file, state);
    while (sessionParseCache.size > MAX_PARSE_CACHE_ENTRIES) {
      const oldest = sessionParseCache.keys().next().value;
      if (oldest === undefined) break;
      sessionParseCache.delete(oldest);
    }
  } catch {
    // Fall through with whatever parsed state we have
  }

  const timeline: TimelineEvent[] = [];
  const records: ToolExecutionRecord[] = [];
  for (const e of state.entries) {
    if (e.timeline) timeline.push(e.timeline);
    if (e.record) records.push(e.record);
  }
  return { timeline, records };
}

/**
 * Outcome of one immutable historical read of an explicitly selected recording:
 * - complete: the watermark covers the whole file and no edge line was dropped
 * - partial: the tail window truncated the head and/or an incomplete edge line
 *   was dropped — provenance flags say which
 * - empty: the recording exists but holds no bytes
 * - missing: the catalog path no longer exists
 * - unreadable: open/stat/read failed for another reason
 * - changed: the opened file no longer matches the approved catalog identity
 *   (replaced, re-pointed, or truncated after selection) — nothing was consumed
 * - invalid: the opened file has no parseable session header
 */
export type SessionSnapshotStatus =
  | "complete"
  | "partial"
  | "empty"
  | "missing"
  | "unreadable"
  | "changed"
  | "invalid";

/**
 * Immutable read watermark captured from the opened descriptor at selection
 * time. `size` is the fixed upper bound of the read window: bytes appended
 * after capture are never consumed. `dev`/`ino` are captured when the platform
 * provides them so later steps can re-verify they hold the same inode.
 */
export interface SessionSnapshotWatermark {
  host: HostType;
  projectCwd: string;
  filePath: string;
  sessionId?: string;
  startedAt?: number;
  dev?: number;
  ino?: number;
  size: number;
  mtimeMs: number;
}

/** Offsets and flags describing exactly which bytes of the watermark were consumed. */
export interface SessionSnapshotProvenance {
  watermark: SessionSnapshotWatermark;
  /** Consumed byte range [windowStart, windowEnd); windowEnd === watermark.size. */
  windowStart: number;
  windowEnd: number;
  /** The window starts past byte 0: the head of the file was not read. */
  truncatedHead: boolean;
  /** A partial line at the window's leading edge was skipped. */
  droppedLeadingLine: boolean;
  /** A trailing line without a newline terminator was not consumed. */
  droppedTrailingLine: boolean;
  /** Window lines that looked like message entries but failed JSON.parse. */
  unparsedLines: number;
}

export interface SessionSnapshot {
  status: SessionSnapshotStatus;
  /** Parsed events, same shape as readSession(); non-empty only for complete/partial. */
  timeline: TimelineEvent[];
  records: ToolExecutionRecord[];
  /** Present once a watermark was captured (empty/complete/partial/changed/invalid). */
  provenance?: SessionSnapshotProvenance;
  /** Short reason for non-complete statuses. */
  detail?: string;
}

function snapshotFailure(
  status: SessionSnapshotStatus,
  detail: string,
  provenance?: SessionSnapshotProvenance,
): SessionSnapshot {
  return { status, timeline: [], records: [], provenance, detail };
}

/**
 * Read one explicitly selected recording as an immutable historical snapshot.
 *
 * The file is opened exactly once; the watermark (identity, dev/ino, size,
 * mtime) is captured from that descriptor, and exactly the fixed tail
 * [max(0, size - MAX_SESSION_BYTES), size) is read through positioned reads on
 * the same descriptor — bytes appended later are never consumed. Identity is
 * re-verified against the opened inode (canonical path still resolves, header
 * cwd normalizes to the catalog project, native session id and header start
 * time match when the catalog captured them); any drift reports `changed`
 * instead of silently consuming another version. The recording format does not
 * record the host, so `host` is carried from the catalog entry and anchored by
 * the path + header checks.
 *
 * Parsing goes through the same per-line helper as readSession() but never
 * touches the lifecycle parse cache: no state is persisted, nothing is written,
 * and ordinary filesystem races surface as statuses, not exceptions.
 */
export function readSessionSnapshot(entry: SessionCatalogEntry): SessionSnapshot {
  let fd: number;
  try {
    fd = fs.openSync(entry.filePath, "r");
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return snapshotFailure("missing", "Recording no longer exists at its catalog path");
    }
    return snapshotFailure("unreadable", `Could not open recording (${code ?? "unknown error"})`);
  }
  try {
    let st: fs.Stats;
    try {
      st = fs.fstatSync(fd);
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      return snapshotFailure("unreadable", `Could not stat opened recording (${code ?? "unknown error"})`);
    }

    // The catalog path must still resolve to the same canonical file; a swapped
    // symlink or removed directory entry means another version sits at that path.
    try {
      if (fs.realpathSync(entry.filePath) !== entry.filePath) {
        return snapshotFailure("changed", "Catalog path no longer resolves to the recorded canonical file");
      }
    } catch {
      return snapshotFailure("changed", "Catalog path no longer resolves to the recorded canonical file");
    }

    const watermark: SessionSnapshotWatermark = {
      host: entry.host,
      projectCwd: entry.projectCwd,
      filePath: entry.filePath,
      sessionId: entry.sessionId,
      startedAt: entry.startedAt,
      dev: typeof st.dev === "number" ? st.dev : undefined,
      ino: typeof st.ino === "number" ? st.ino : undefined,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
    const noWindow: Omit<SessionSnapshotProvenance, "watermark"> = {
      windowStart: 0,
      windowEnd: 0,
      truncatedHead: false,
      droppedLeadingLine: false,
      droppedTrailingLine: false,
      unparsedLines: 0,
    };

    if (st.size === 0) {
      return snapshotFailure("empty", "Recording is empty", { watermark, ...noWindow });
    }

    // Identity re-verification against the opened inode's own header.
    const header = readSessionHeaderFromFd(fd);
    if (!header || typeof header.cwd !== "string") {
      return snapshotFailure("invalid", "Opened recording has no parseable session header", { watermark, ...noWindow });
    }
    let headerCwd: string;
    try {
      headerCwd = fs.realpathSync(header.cwd);
    } catch {
      headerCwd = path.resolve(header.cwd);
    }
    if (headerCwd !== entry.projectCwd) {
      return snapshotFailure("changed", "Recording header cwd no longer matches the catalog project", { watermark, ...noWindow });
    }
    if (entry.sessionId !== undefined && header.id !== entry.sessionId) {
      return snapshotFailure("changed", "Recording session id no longer matches the catalog entry", { watermark, ...noWindow });
    }
    const headerStart = header.timestamp ? Date.parse(header.timestamp) : NaN;
    if (entry.startedAt !== undefined && headerStart !== entry.startedAt) {
      return snapshotFailure("changed", "Recording start time no longer matches the catalog entry", { watermark, ...noWindow });
    }
    // The header is authoritative when the catalog lacked optional fields.
    watermark.sessionId = typeof header.id === "string" ? header.id : watermark.sessionId;
    watermark.startedAt = Number.isNaN(headerStart) ? watermark.startedAt : headerStart;

    const windowStart = Math.max(0, st.size - MAX_SESSION_BYTES);
    const windowEnd = st.size;
    const buf = Buffer.alloc(windowEnd - windowStart);
    let readTotal = 0;
    try {
      while (readTotal < buf.length) {
        const n = fs.readSync(fd, buf, readTotal, buf.length - readTotal, windowStart + readTotal);
        if (n <= 0) break;
        readTotal += n;
      }
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      return snapshotFailure("unreadable", `Could not read recording window (${code ?? "unknown error"})`);
    }
    if (readTotal < buf.length) {
      // The file shrank between fstat and read: the watermarked version is gone.
      return snapshotFailure("changed", "Recording was truncated after the watermark was captured", { watermark, ...noWindow });
    }

    // Edge alignment on bytes, then a single decode of exactly the consumed
    // window — no intermediate full-window strings.
    let startByte = 0;
    let droppedLeadingLine = false;
    if (windowStart > 0) {
      const nl = buf.indexOf(0x0a);
      startByte = nl === -1 ? buf.length : nl + 1;
      droppedLeadingLine = nl > 0;
    }
    const lastNl = buf.lastIndexOf(0x0a);
    const endByte = lastNl === -1 ? 0 : lastNl + 1;
    const droppedTrailingLine = endByte < buf.length;
    const truncatedHead = windowStart > 0;

    const timeline: TimelineEvent[] = [];
    const records: ToolExecutionRecord[] = [];
    let unparsedLines = 0;
    if (endByte > startByte) {
      const text = buf.subarray(startByte, endByte).toString("utf-8");
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        const parsed = parseSessionEntryLine(line);
        if (parsed === undefined) {
          unparsedLines++;
          continue;
        }
        for (const p of parsed) {
          if (p.timeline) timeline.push(p.timeline);
          if (p.record) records.push(p.record);
        }
      }
    }

    const partial = truncatedHead || droppedLeadingLine || droppedTrailingLine;
    const provenance: SessionSnapshotProvenance = {
      watermark,
      windowStart,
      windowEnd,
      truncatedHead,
      droppedLeadingLine,
      droppedTrailingLine,
      unparsedLines,
    };
    return {
      status: partial ? "partial" : "complete",
      timeline,
      records,
      provenance,
      detail: partial
        ? `Read tail window [${windowStart}, ${windowEnd}) of ${st.size} bytes; incomplete edge lines were dropped`
        : undefined,
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Descriptor already unusable; the read outcome stands.
    }
  }
}

export function deriveFrictionPoints(records: readonly ToolExecutionRecord[]): FrictionPoint[] {
  const frictions: FrictionPoint[] = [];
  const errorMap = new Map<string, { errors: string[]; durations: number[] }>();
  for (const r of records) {
    if (r.isError) {
      const entry = errorMap.get(r.toolName) ?? { errors: [], durations: [] };
      entry.errors.push(r.outputPreview ?? "Execution failed");
      entry.durations.push(r.durationMs);
      errorMap.set(r.toolName, entry);
    }
  }
  for (const [tool, { errors, durations }] of errorMap.entries()) {
    // Harness² Rule: >= 2 errors threshold to avoid false positives on transient exploration
    if (errors.length >= 2) {
      const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
      const slowNote = avgMs >= 5000 ? `, avg ${(avgMs / 1000).toFixed(1)}s per call` : "";
      frictions.push({
        type: "tool_error_loop",
        toolName: tool,
        description: `Tool "${tool}" failed ${errors.length} times in session recording${slowNote}`,
        frequency: errors.length,
        sampleErrors: errors.slice(0, 3),
      });
    }
  }
  return frictions;
}

export function topFailingTools(records: readonly ToolExecutionRecord[]): Array<{ tool: string; count: number }> {
  const countMap = new Map<string, number>();
  for (const r of records) {
    if (r.isError) countMap.set(r.toolName, (countMap.get(r.toolName) ?? 0) + 1);
  }
  return Array.from(countMap.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);
}
