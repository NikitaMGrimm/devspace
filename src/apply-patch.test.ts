import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStructuredPatch } from "./apply-patch.js";

const root = await mkdtemp(join(tmpdir(), "devspace-v4a-"));

const created = await applyStructuredPatch(root, {
  type: "create_file",
  path: "created.txt",
  diff: "+hello\n+world\n",
});
assert.deepEqual(created, {
  status: "completed", operation: "create_file", path: "created.txt", changed: true, fuzz: 0,
});
assert.equal(await readFile(join(root, "created.txt"), "utf8"), "hello\nworld\n");
await applyStructuredPatch(root, {
  type: "create_file", path: "created-crlf.txt", diff: "+hello\r\n+world\r\n",
});
assert.equal(await readFile(join(root, "created-crlf.txt"), "utf8"), "hello\r\nworld\r\n");

await applyStructuredPatch(root, { type: "create_file", path: "empty.txt", diff: "" });
assert.equal(await readFile(join(root, "empty.txt"), "utf8"), "");
await assert.rejects(
  applyStructuredPatch(root, { type: "create_file", path: "created.txt", diff: "+again" }),
  /already exists/,
);
await assert.rejects(
  applyStructuredPatch(root, { type: "create_file", path: "missing/child.txt", diff: "+x" }),
  /Parent directory does not exist/,
);

await writeFile(join(root, "lf.txt"), "one\ntwo\nthree\nfour\n");
if (process.platform !== "win32") await chmod(join(root, "lf.txt"), 0o755);
const updated = await applyStructuredPatch(root, {
  type: "update_file",
  path: "lf.txt",
  diff: "@@\n one\n-two\n+TWO\n three\n@@\n-four\n+FOUR\n*** End of File",
});
assert.equal(updated.changed, true);
assert.equal(await readFile(join(root, "lf.txt"), "utf8"), "one\nTWO\nthree\nFOUR\n");
if (process.platform !== "win32") assert.notEqual((await stat(join(root, "lf.txt"))).mode & 0o111, 0);

await writeFile(join(root, "crlf.txt"), "one\r\ntwo\r\n");
await applyStructuredPatch(root, {
  type: "update_file", path: "crlf.txt", diff: "@@\n one\n-two\n+TWO",
});
assert.equal(await readFile(join(root, "crlf.txt"), "utf8"), "one\r\nTWO\r\n");

await writeFile(join(root, "repeated.txt"), "same\nold\nsame\nmiddle\nsame\nold\nsame\n");
const repeated = await applyStructuredPatch(root, {
  type: "update_file",
  path: "repeated.txt",
  diff: "@@ middle\n same  \n-old\n+new\n same",
});
assert.ok(repeated.fuzz > 0);
assert.equal(await readFile(join(root, "repeated.txt"), "utf8"), "same\nold\nsame\nmiddle\nsame\nnew\nsame\n");

await assert.rejects(
  applyStructuredPatch(root, {
    type: "update_file", path: "lf.txt", diff: "@@\n-missing\n+replacement",
  }),
  /Patch context did not match/,
);
assert.equal(await readFile(join(root, "lf.txt"), "utf8"), "one\nTWO\nthree\nFOUR\n");

for (const bad of [
  { type: "create_file" as const, path: "../escape.txt", diff: "+x" },
  { type: "create_file" as const, path: join(root, "absolute.txt"), diff: "+x" },
]) {
  await assert.rejects(applyStructuredPatch(root, bad), /relative path|traversal/);
}

const outside = await mkdtemp(join(tmpdir(), "devspace-v4a-outside-"));
await symlink(outside, join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
await assert.rejects(
  applyStructuredPatch(root, { type: "create_file", path: "outside/escape.txt", diff: "+x" }),
  /outside the workspace/,
);
await symlink(join(root, "lf.txt"), join(root, "leaf-link.txt"));
await assert.rejects(
  applyStructuredPatch(root, { type: "update_file", path: "leaf-link.txt", diff: "@@\n-one\n+ONE" }),
  /symlink leaf/,
);

await writeFile(join(root, "binary.dat"), Buffer.from([65, 0, 66]));
await assert.rejects(
  applyStructuredPatch(root, { type: "update_file", path: "binary.dat", diff: "@@\n-A\n+B" }),
  /Binary files/,
);
await assert.rejects(
  applyStructuredPatch(root, { type: "create_file", path: "nul.txt", diff: "+a\0b" }),
  /NUL bytes/,
);
await assert.rejects(
  applyStructuredPatch(root, {
    type: "update_file", path: "lf.txt", diff: "*** Begin Patch\n*** Update File: lf.txt",
  }),
  /bare V4A diff/,
);

await writeFile(join(root, "delete.txt"), "delete\n");
await applyStructuredPatch(root, { type: "delete_file", path: "delete.txt" });
await assert.rejects(lstat(join(root, "delete.txt")), /ENOENT/);
await assert.rejects(
  applyStructuredPatch(root, { type: "delete_file", path: "delete.txt" }),
  /does not exist/,
);

await mkdir(join(root, "serial"));
await writeFile(join(root, "serial", "value.txt"), "zero\n");
const first = applyStructuredPatch(root, {
  type: "update_file", path: "serial/value.txt", diff: "@@\n-zero\n+one",
});
const second = applyStructuredPatch(root, {
  type: "update_file", path: "serial/value.txt", diff: "@@\n-one\n+two",
});
await Promise.all([first, second]);
assert.equal(await readFile(join(root, "serial", "value.txt"), "utf8"), "two\n");

await assert.rejects(
  applyStructuredPatch(root, {
    type: "update_file", path: "serial/value.txt", diff: "*** End of File",
  }),
  /End-of-file marker must follow an update hunk/,
);
