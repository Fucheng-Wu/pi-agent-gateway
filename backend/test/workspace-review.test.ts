import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager } from "../src/lib/workspace-manager.js";
import { captureWorkspace, compareWorkspace, saveRunReview, loadRunReview } from "../src/lib/run-review.js";
const exec = promisify(execFile);

test("workspace selection persists, validates paths, browses directories and recovers a missing project", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-test-"));
  try {
    const project = join(root, "project"), agent = join(root, "agent");
    await mkdir(project);
    const manager = new WorkspaceManager(agent);
    await manager.open(root);
    await assert.rejects(manager.validate("relative/path"));
    await manager.select(await manager.validate(project));
    assert.ok((await manager.browse(root)).directories.some((item) => item.name === "project"));
    const restored = new WorkspaceManager(agent);
    assert.equal(await restored.open(root), await manager.validate(project));
    assert.ok(restored.info().recent.includes(root));
    await rm(project, { recursive: true });
    assert.equal(await new WorkspaceManager(agent).open(root), root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("run review isolates pre-existing edits and includes added/deleted files without reading ignored files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-test-"));
  try {
    await exec("git", ["init"], { cwd: root, windowsHide: true });
    await writeFile(join(root, ".gitignore"), "ignored.txt\nagent/\n");
    await writeFile(join(root, "existing.txt"), "already edited before task\n");
    await writeFile(join(root, "deleted.txt"), "remove during task\n");
    await exec("git", ["add", "."], { cwd: root, windowsHide: true });
    await writeFile(join(root, "ignored.txt"), "secret");
    const before = await captureWorkspace(root);
    await writeFile(join(root, "existing.txt"), "already edited before task\nnew change\n");
    await writeFile(join(root, "added.txt"), "new file\n");
    await rm(join(root, "deleted.txt"));
    const review = { ...compareWorkspace(before, await captureWorkspace(root)), workspace: root, startedAt: new Date().toISOString(), commands: [] };
    assert.deepEqual(review.files.map((item) => [item.path, item.status]), [["added.txt", "added"], ["deleted.txt", "deleted"], ["existing.txt", "modified"]]);
    assert.match(review.files[2].diff!, /\+new change/);
    assert.doesNotMatch(review.files[2].diff!, /\+already edited/);
    await saveRunReview(join(root, "agent"), "session-test", review);
    assert.deepEqual(await loadRunReview(join(root, "agent"), "session-test"), JSON.parse(JSON.stringify(review)));
    assert.equal((await readFile(join(root, "existing.txt"), "utf8")).includes("new change"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
