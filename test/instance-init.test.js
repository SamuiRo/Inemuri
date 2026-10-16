import test from "node:test";
import assert from "node:assert/strict";

import { referencedFiles, targetPath, rewriteRefs } from "../src/shared/instanceInit.js";
import path from "path";

import { instanceLayout } from "../src/config/instance.js";

test("referencedFiles: every file and avatar, at any depth", () => {
  const raw = {
    personas: [{ key: "guide", avatar: "srv/guide.png" }],
    categories: [{ channels: [{ messages: [{ file: "srv/welcome.md" }, { file: "shared.md" }, { rolePanel: "x" }] }] }],
  };
  assert.deepEqual(referencedFiles(raw).sort(), ["shared.md", "srv/guide.png", "srv/welcome.md"]);
});

test("targetPath: the server's own prefix goes, anything else keeps its path", () => {
  assert.equal(targetPath("plane-of-euthymia/welcome.md", "plane-of-euthymia"), "welcome.md");
  assert.equal(targetPath("test-rules.md", "test"), "test-rules.md");
  assert.equal(targetPath("other/rules.md", "test"), "other/rules.md");
});

test("rewriteRefs: only file/avatar values of this server, the layout of the file kept", () => {
  const text = [
    "{",
    '  "personas": [{ "key": "s", "avatar": "srv/sekai.png" }],',
    '  "channels": [{ "key": "intro", "name": "srv/not-a-ref", "messages": [{ "file": "srv/welcome.md" }, {"file":"srv/map.md"}] }]',
    "}",
  ].join("\n");
  const out = rewriteRefs(text, "srv");
  assert.match(out, /"avatar": "sekai\.png"/);
  assert.match(out, /"file": "welcome\.md"/);
  assert.match(out, /"file":"map\.md"/);
  assert.match(out, /"name": "srv\/not-a-ref"/, "інші поля не чіпаються");
  assert.equal(out.split("\n").length, text.split("\n").length, "форматування ціле");
  assert.equal(rewriteRefs(text, "other"), text);
});

test("instanceLayout: one folder, five parts", () => {
  const l = instanceLayout("/srv/inemuri/instance");
  assert.deepEqual(Object.keys(l).sort(), ["config", "database", "exports", "knowledge", "provision", "root"]);
  assert.equal(l.config, path.join("/srv/inemuri/instance", "config"));
});
