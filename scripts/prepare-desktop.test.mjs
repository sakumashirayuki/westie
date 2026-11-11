import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "westie-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = new URL("./prepare-desktop.mjs", import.meta.url);
  const version = readFileSync(script, "utf8").match(/const NODE_VERSION = "([^"]+)"/)[1];
  const nodeDirectory = `node-v${version}-darwin-${process.arch}`;
  const tarball = `${nodeDirectory}.tar.gz`;
  for (const directory of ["scripts", "dist/src", "dist/native", "web/dist", "desktop", "fake-bin", `source/${nodeDirectory}/bin`]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  cpSync(script, join(root, "scripts/prepare-desktop.mjs"));
  for (const file of ["dist/src/server-bootstrap.js", "dist/native/process-containment-helper", "web/dist/index.html", "desktop/backend-entry.mjs"]) {
    writeFileSync(join(root, file), "fixture");
  }
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, "source", nodeDirectory, "bin/node"), "fixture-node");
  execFileSync("/usr/bin/tar", ["-czf", join(root, "node.tar.gz"), "-C", join(root, "source"), nodeDirectory]);
  const archive = readFileSync(join(root, "node.tar.gz"));
  const checksum = createHash("sha256").update(archive).digest("hex");
  writeFileSync(join(root, "SHASUMS256.txt"), `${checksum}  ${tarball}\n`);
  writeFileSync(join(root, "fake-bin/npm"), `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(root, "npm-runs"))}, "install\\n");\n`);
  chmodSync(join(root, "fake-bin/npm"), 0o755);
  writeFileSync(join(root, "mock-fetch.mjs"), `
    import { appendFileSync, readFileSync } from "node:fs";
    globalThis.fetch = async (url) => {
      appendFileSync("requests", url + "\\n");
      if (process.env.TEST_NODE_OFFLINE) throw new Error("Node download is offline");
      const file = url.endsWith("/SHASUMS256.txt") ? "SHASUMS256.txt" : "node.tar.gz";
      return new Response(readFileSync(file));
    };
  `);
  return {
    root,
    archive,
    checksum,
    cachedArchive: join(root, ".desktop-cache/node", tarball),
    run(offline = false) {
      return spawnSync(process.execPath, ["--import", join(root, "mock-fetch.mjs"), "scripts/prepare-desktop.mjs"], {
        cwd: root,
        env: { ...process.env, PATH: `${join(root, "fake-bin")}:${process.env.PATH}`, TEST_NODE_OFFLINE: offline ? "1" : "" },
        encoding: "utf8",
      });
    },
    requests() {
      return readFileSync(join(root, "requests"), "utf8").trim().split("\n");
    },
  };
}

function succeeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("prepare runtime downloads once and reuses verified Node cache offline", (t) => {
  const f = fixture(t);
  succeeded(f.run());
  assert.deepEqual(readFileSync(f.cachedArchive), f.archive);
  assert.equal(f.requests().length, 2);
  writeFileSync(join(f.root, ".desktop-runtime/stale"), "stale");

  succeeded(f.run(true));
  assert.equal(f.requests().length, 2, "cache hit must not request the checksum list or archive");
  assert.equal(existsSync(join(f.root, ".desktop-runtime/stale")), false);
  assert.equal(readFileSync(join(f.root, ".desktop-runtime/dev-runtime/bin/node"), "utf8"), "fixture-node");
  assert.equal(readFileSync(join(f.root, "npm-runs"), "utf8"), "install\ninstall\n");
});

test("prepare runtime replaces corrupt or incomplete Node cache", (t) => {
  const f = fixture(t);
  succeeded(f.run());
  writeFileSync(f.cachedArchive, "corrupt archive");
  succeeded(f.run());
  assert.deepEqual(readFileSync(f.cachedArchive), f.archive);
  assert.equal(f.requests().length, 4);

  rmSync(`${f.cachedArchive}.sha256`);
  succeeded(f.run());
  assert.equal(readFileSync(`${f.cachedArchive}.sha256`, "utf8").trim(), f.checksum);
  assert.equal(f.requests().length, 6);
});

test("prepare runtime rejects a downloaded Node archive with a mismatched checksum", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "node.tar.gz"), "invalid download");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(existsSync(f.cachedArchive), false);
  assert.equal(existsSync(join(f.root, ".desktop-runtime/dev-runtime/bin/node")), false);
  assert.equal(existsSync(join(f.root, "npm-runs")), false);
});
