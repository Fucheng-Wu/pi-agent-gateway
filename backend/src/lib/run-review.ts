import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { RunReview } from "../../../shared/types.js";

const exec = promisify(execFile);
const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
interface FileState { hash: string; text?: string; }
export interface WorkspaceSnapshot { files: Map<string, FileState>; note?: string; available: boolean; }

/** Compare the workspace to its pre-task contents, including existing uncommitted files. */
export async function captureWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, FileState>();
  try {
    const { stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], { cwd, windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    const paths = [...new Set(stdout.split("\0").filter(Boolean))];
    const base = await realpath(cwd);
    let total = 0;
    let omitted = paths.length > 5000;
    for (const path of paths.slice(0, 5000)) {
      const absolute = resolve(base, path);
      const rel = relative(base, absolute);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) continue;
      try {
        const info = await lstat(absolute);
        if (!info.isFile() || info.isSymbolicLink()) { omitted = true; continue; }
        // Parent directory symlinks must not turn a project snapshot into an external read.
        const canonical = await realpath(absolute);
        const canonicalRel = relative(base, canonical);
        if (isAbsolute(canonicalRel) || canonicalRel === ".." || canonicalRel.startsWith("../") || canonicalRel.startsWith("..\\")) { omitted = true; continue; }
        if (info.size > MAX_FILE || total + info.size > MAX_TOTAL) {
          files.set(path, { hash: `omitted:${info.size}:${info.mtimeMs}` }); omitted = true; continue;
        }
        const bytes = await readFile(absolute);
        total += bytes.length;
        files.set(path, { hash: createHash("sha256").update(bytes).digest("hex"), text: bytes.includes(0) ? undefined : bytes.toString("utf8") });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") omitted = true; }
    }
    return { files, available: true, note: omitted ? "部分文件因大小、数量或链接限制未生成完整 diff。" : undefined };
  } catch {
    return { files, available: false, note: "此目录无法读取 Git 文件清单；仍会记录命令，文件 diff 暂不可用。" };
  }
}

export function compareWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): Pick<RunReview, "files" | "note"> {
  if (!before.available || !after.available) return { files: [], note: before.note || after.note };
  const files: RunReview["files"] = [];
  let budget = 240_000;
  for (const path of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
    const old = before.files.get(path), next = after.files.get(path);
    if (old?.hash === next?.hash) continue;
    if (files.length >= 200) return { files, note: "仅展示前 200 个变化文件。" };
    const status = !old ? "added" : !next ? "deleted" : "modified";
    let diff: string | undefined;
    if ((!old || old.text !== undefined) && (!next || next.text !== undefined) && budget > 0) {
      diff = createTwoFilesPatch(`a/${path}`, `b/${path}`, old?.text ?? "", next?.text ?? "", "", "", { context: 3, timeout: 100 });
      if (diff && diff.length <= budget) budget -= diff.length;
      else diff = undefined;
    }
    files.push({ path: path.replaceAll("\\", "/"), status, diff, omitted: diff ? undefined : "二进制文件、较大文件或 diff 超出展示限制。" });
  }
  return { files, note: before.note || after.note };
}

function reviewPath(agentDir: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid review session ID");
  return join(agentDir, "gateway-reviews", `${id}.json`);
}

export async function saveRunReview(agentDir: string, id: string, review: RunReview): Promise<void> {
  const target = reviewPath(agentDir, id);
  const temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(join(agentDir, "gateway-reviews"), { recursive: true });
  try {
    await writeFile(temp, JSON.stringify(review), { mode: 0o600 });
    await rename(temp, target);
  } finally { await rm(temp, { force: true }); }
}

export async function loadRunReview(agentDir: string, id: string): Promise<RunReview | undefined> {
  try { return JSON.parse(await readFile(reviewPath(agentDir, id), "utf8")); }
  catch { return undefined; }
}

export async function deleteRunReview(agentDir: string, id: string): Promise<void> { await rm(reviewPath(agentDir, id), { force: true }); }
