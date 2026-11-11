import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverWorkspaceSkills } from "../src/infrastructure/workspace-skills.js";

async function createWorkspace(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "workspace-skills-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function createHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "user-skills-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function writeSkill(
  workspace: string,
  name: string,
  description = `Description for ${name}.`,
  body = `# ${name}\n`,
): Promise<string> {
  const directory = join(workspace, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  const content = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    body,
  ].join("\n");
  await writeFile(join(directory, "SKILL.md"), content, "utf8");
  return content;
}

async function writeHomeSkill(
  home: string,
  name: string,
  description = `User ${name}.`,
  body = `# user-${name}\n`,
): Promise<void> {
  const directory = join(home, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  const content = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    body,
  ].join("\n");
  await writeFile(join(directory, "SKILL.md"), content, "utf8");
}

test("returns an empty registry when the skills directory is missing", async (t) => {
  const workspace = await createWorkspace(t);

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.deepEqual(registry.skills, []);
  assert.equal(registry.catalog, undefined);
  assert.deepEqual(registry.diagnostics, []);
});

test("accepts frontmatter whose closing delimiter is at end of file", async (t) => {
  const workspace = await createWorkspace(t);
  const directory = join(workspace, ".agents", "skills", "minimal");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: minimal\ndescription: Minimal.\n---",
  );

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.deepEqual(registry.skills, [
    { name: "minimal", description: "Minimal.", source: "workspace" },
  ]);
});

test("discovers direct workspace skills in stable name order", async (t) => {
  const workspace = await createWorkspace(t);
  const beta = await writeSkill(workspace, "beta");
  const alpha = await writeSkill(
    workspace,
    "alpha",
    ">\n  Review code changes.\n  Check tests.",
  );
  await writeSkill(workspace, "nested");
  await writeSkill(join(workspace, ".agents", "skills", "nested"), "deeper");

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.deepEqual(registry.skills, [
    { name: "alpha", description: "Review code changes. Check tests.", source: "workspace" },
    { name: "beta", description: "Description for beta.", source: "workspace" },
    { name: "nested", description: "Description for nested.", source: "workspace" },
  ]);
  assert.match(registry.catalog ?? "", /<name>alpha<\/name>/);
  assert.match(registry.catalog ?? "", /<description>Review code changes/);
  assert.doesNotMatch(registry.catalog ?? "", /# alpha/);
  assert.equal((await registry.load("beta")).content, beta);
  assert.notEqual(alpha, "");
});

test("skips invalid skills and keeps valid skills available", async (t) => {
  const workspace = await createWorkspace(t);
  await writeSkill(workspace, "valid");
  await writeSkill(workspace, "wrong-directory");
  await writeFile(
    join(workspace, ".agents", "skills", "wrong-directory", "SKILL.md"),
    "---\nname: another-name\ndescription: Wrong.\n---\nbody",
  );
  const missingDescription = join(
    workspace,
    ".agents",
    "skills",
    "missing-description",
  );
  await mkdir(missingDescription, { recursive: true });
  await writeFile(
    join(missingDescription, "SKILL.md"),
    "---\nname: missing-description\n---\nbody",
  );
  const invalidYaml = join(workspace, ".agents", "skills", "invalid-yaml");
  await mkdir(invalidYaml, { recursive: true });
  await writeFile(
    join(invalidYaml, "SKILL.md"),
    "---\nname: [invalid-yaml\ndescription: Broken.\n---\nbody",
  );

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.deepEqual(registry.skills, [
    { name: "valid", description: "Description for valid.", source: "workspace" },
  ]);
  assert.equal(registry.diagnostics.length, 3);
  assert.ok(registry.diagnostics.every((item) => item.code === "INVALID_SKILL"));
});

test("reports a missing skill name explicitly", async (t) => {
  const workspace = await createWorkspace(t);
  const directory = join(workspace, ".agents", "skills", "missing-name");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    "---\ndescription: Missing name.\n---\nbody",
  );

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.deepEqual(registry.skills, []);
  assert.equal(
    registry.diagnostics[0]?.message,
    "Skill frontmatter must define name.",
  );
});

test("ignores auxiliary skill directories without SKILL.md", async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(join(workspace, ".agents", "skills", "_shared"), {
    recursive: true,
  });

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.deepEqual(registry.skills, []);
  assert.deepEqual(registry.diagnostics, []);
});

test("accepts a 64 KiB SKILL.md and skips one byte more", async (t) => {
  const workspace = await createWorkspace(t);
  const exactDirectory = join(workspace, ".agents", "skills", "exact-size");
  const oversizedDirectory = join(
    workspace,
    ".agents",
    "skills",
    "oversized",
  );
  await mkdir(exactDirectory, { recursive: true });
  await mkdir(oversizedDirectory, { recursive: true });
  const exactPrefix = "---\nname: exact-size\ndescription: Exact.\n---\n";
  const oversizedPrefix = "---\nname: oversized\ndescription: Oversized.\n---\n";
  await writeFile(
    join(exactDirectory, "SKILL.md"),
    exactPrefix + "x".repeat(64 * 1024 - Buffer.byteLength(exactPrefix)),
  );
  await writeFile(
    join(oversizedDirectory, "SKILL.md"),
    oversizedPrefix +
      "x".repeat(64 * 1024 + 1 - Buffer.byteLength(oversizedPrefix)),
  );

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.deepEqual(registry.skills, [
    { name: "exact-size", description: "Exact.", source: "workspace" },
  ]);
  assert.match(registry.diagnostics[0]?.message ?? "", /exceeds 65536 bytes/);
});

test("skips frontmatter that does not close within 16 KiB", async (t) => {
  const workspace = await createWorkspace(t);
  const directory = join(workspace, ".agents", "skills", "long-header");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: long-header\ndescription: Long.\npadding: " +
      "x".repeat(17 * 1024) +
      "\n---\nbody",
  );

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.deepEqual(registry.skills, []);
  assert.match(
    registry.diagnostics[0]?.message ?? "",
    /frontmatter must close within 16384 bytes/,
  );
});

test("escapes skill metadata before rendering the XML catalog", async (t) => {
  const workspace = await createWorkspace(t);
  const directory = join(workspace, ".agents", "skills", "escaped");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      "name: escaped",
      "description: '<review> & \"quotes\"'",
      "---",
      "body",
    ].join("\n"),
  );

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.match(
    registry.catalog ?? "",
    /&lt;review&gt; &amp; &quot;quotes&quot;/,
  );
  assert.doesNotMatch(registry.catalog ?? "", /<review>/);
});

test("rejects symbolic links for the skills root, skill directory, and SKILL.md", async (t) => {
  const workspace = await createWorkspace(t);
  const external = await mkdtemp(join(tmpdir(), "workspace-skills-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(join(external, "skills"), { recursive: true });
  await mkdir(join(workspace, ".agents"), { recursive: true });
  await symlink(join(external, "skills"), join(workspace, ".agents", "skills"));

  const rootRegistry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });
  assert.deepEqual(rootRegistry.skills, []);
  assert.equal(rootRegistry.diagnostics[0]?.code, "INVALID_SKILLS_ROOT");

  await rm(join(workspace, ".agents", "skills"));
  await mkdir(join(workspace, ".agents", "skills"));
  const targetDirectory = join(external, "linked-directory");
  await mkdir(targetDirectory);
  await writeFile(
    join(targetDirectory, "SKILL.md"),
    "---\nname: linked-directory\ndescription: Linked.\n---\nbody",
  );
  await symlink(
    targetDirectory,
    join(workspace, ".agents", "skills", "linked-directory"),
  );
  const linkedFileDirectory = join(
    workspace,
    ".agents",
    "skills",
    "linked-file",
  );
  await mkdir(linkedFileDirectory);
  await writeFile(
    join(external, "linked-file.md"),
    "---\nname: linked-file\ndescription: Linked.\n---\nbody",
  );
  await symlink(
    join(external, "linked-file.md"),
    join(linkedFileDirectory, "SKILL.md"),
  );

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });
  assert.deepEqual(registry.skills, []);
  assert.equal(registry.diagnostics.length, 2);
});

test("truncates the catalog deterministically without exposing omitted skills", async (t) => {
  const workspace = await createWorkspace(t);
  for (let index = 0; index < 40; index += 1) {
    await writeSkill(
      workspace,
      `skill-${String(index).padStart(2, "0")}`,
      `${String(index).padStart(2, "0")}-${"x".repeat(1021)}`,
    );
  }

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });

  assert.ok(registry.skills.length > 0);
  assert.ok(registry.skills.length < 40);
  assert.ok(Buffer.byteLength(registry.catalog ?? "", "utf8") <= 32 * 1024);
  assert.equal(registry.skills[0]?.name, "skill-00");
  assert.equal(registry.diagnostics.at(-1)?.code, "CATALOG_TRUNCATED");
  await assert.rejects(registry.load("skill-39"), /Unknown skill/);
});

test("revalidates and rereads SKILL.md when a skill is loaded", async (t) => {
  const workspace = await createWorkspace(t);
  await writeSkill(workspace, "mutable", "Mutable.", "version one");
  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });
  const path = join(
    workspace,
    ".agents",
    "skills",
    "mutable",
    "SKILL.md",
  );
  await writeFile(
    path,
    "---\nname: mutable\ndescription: Mutable.\n---\nversion two",
  );

  assert.match((await registry.load("mutable")).content, /version two/);

  await writeFile(
    path,
    Buffer.concat([
      Buffer.from("---\nname: mutable\ndescription: Mutable.\n---\n"),
      Buffer.from([0xc3, 0x28]),
    ]),
  );
  await assert.rejects(registry.load("mutable"), /valid UTF-8/);
});

test("rejects a skill directory replaced by a symbolic link after discovery", async (t) => {
  const workspace = await createWorkspace(t);
  await writeSkill(workspace, "replaceable", "Replaceable.", "trusted");
  const registry = await discoverWorkspaceSkills(workspace, { homeDir: await createHome(t) });
  const skillDirectory = join(
    workspace,
    ".agents",
    "skills",
    "replaceable",
  );
  const replacementDirectory = join(workspace, "replacement");
  await mkdir(replacementDirectory);
  await writeFile(
    join(replacementDirectory, "SKILL.md"),
    "---\nname: replaceable\ndescription: Replaceable.\n---\nUNTRUSTED",
  );
  await rm(skillDirectory, { recursive: true });
  await symlink(replacementDirectory, skillDirectory);

  await assert.rejects(
    registry.load("replaceable"),
    /directory changed after discovery/,
  );
});

// ---- 用户级 Skill（验收 1–6）----

test("discovers only user-level skills with source user", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  await writeHomeSkill(home, "browser-cli", "Drive a browser.");

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  assert.deepEqual(registry.skills, [
    { name: "browser-cli", description: "Drive a browser.", source: "user" },
  ]);
  assert.match(registry.catalog ?? "", /<name>browser-cli<\/name>/);
  assert.deepEqual(registry.diagnostics, []);
});

test("a missing user root produces no diagnostics", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  // home 里没有 .agents/skills

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  assert.deepEqual(registry.skills, []);
  assert.deepEqual(registry.diagnostics, []);
});

test("workspace skill shadows a same-named user skill with SKILL_SHADOWED", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  await writeSkill(workspace, "shared", "Workspace shared.");
  await writeHomeSkill(home, "shared", "User shared.");

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  assert.deepEqual(registry.skills, [
    { name: "shared", description: "Workspace shared.", source: "workspace" },
  ]);
  assert.equal(registry.diagnostics[0]?.code, "SKILL_SHADOWED");
  assert.match(registry.diagnostics[0]?.message ?? "", /shared/);

  const loaded = await registry.load("shared");
  assert.equal(loaded.source, "workspace");
});

test("user-level symlinked root loads; workspace does not", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  const external = await mkdtemp(join(tmpdir(), "user-skills-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));

  // 用户级 skills 根是一个符号链接，指向 home 外。
  const externalSkills = join(external, "skills");
  await mkdir(externalSkills, { recursive: true });
  const userSkill = join(externalSkills, "linked-skill");
  await mkdir(userSkill);
  await writeFile(
    join(userSkill, "SKILL.md"),
    "---\nname: linked-skill\ndescription: Linked user skill.\n---\nbody",
  );
  await mkdir(join(home, ".agents"), { recursive: true });
  await symlink(externalSkills, join(home, ".agents", "skills"));

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });
  assert.deepEqual(registry.skills, [
    { name: "linked-skill", description: "Linked user skill.", source: "user" },
  ]);
  assert.equal((await registry.load("linked-skill")).source, "user");

  // workspace 侧同样的 skills 根符号链接仍被拒绝（原有测试已覆盖，这里补充
  // 一个「源目录在 workspace 外」的断言）。
  await mkdir(join(workspace, ".agents"), { recursive: true });
  await symlink(externalSkills, join(workspace, ".agents", "skills"));
  const wsRegistry = await discoverWorkspaceSkills(workspace, { homeDir: home });
  assert.equal(
    wsRegistry.diagnostics[0]?.code,
    "INVALID_SKILLS_ROOT",
  );
});

test("user-level SKILL.md symlink is rejected", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  const external = await mkdtemp(join(tmpdir(), "user-skills-file-"));
  t.after(() => rm(external, { recursive: true, force: true }));

  const skillDir = join(home, ".agents", "skills", "linked-file");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(external, "linked.md"),
    "---\nname: linked-file\ndescription: Linked.\\n---\nbody".replace("\\n", "\n"),
  );
  await symlink(join(external, "linked.md"), join(skillDir, "SKILL.md"));

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  assert.deepEqual(registry.skills, []);
  assert.equal(registry.diagnostics[0]?.code, "INVALID_SKILL");
});

test("user-level skill directory as a two-level symlink is discovered and loads", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  const external = await mkdtemp(join(tmpdir(), "user-skills-two-level-"));

  // 真实 Skill 目录在 home 外。
  const realSkill = join(external, "real-skill");
  await mkdir(realSkill, { recursive: true });
  await writeFile(
    join(realSkill, "SKILL.md"),
    "---\nname: browser-cli\ndescription: Two-level linked skill.\n---\nbody",
  );

  // 第一级链接指向第二级链接，第二级链接再指向真实目录。
  const secondHop = join(external, "second-hop");
  await symlink(realSkill, secondHop);
  const skillsRoot = join(home, ".agents", "skills");
  await mkdir(skillsRoot, { recursive: true });
  await symlink(secondHop, join(skillsRoot, "browser-cli"));

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  assert.deepEqual(registry.skills, [
    {
      name: "browser-cli",
      description: "Two-level linked skill.",
      source: "user",
    },
  ]);
  const loaded = await registry.load("browser-cli");
  assert.match(loaded.content, /body/);
  assert.equal(loaded.source, "user");
  assert.equal(loaded.directory, await realpath(realSkill));
});

test("a dangling or non-directory user-level skill symlink reports INVALID_SKILL", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  const skillsRoot = join(home, ".agents", "skills");
  await mkdir(skillsRoot, { recursive: true });

  // 断链：指向不存在的目标。
  await symlink(join(home, ".agents", "does-not-exist"), join(skillsRoot, "dangling"));
  // 指向文件。
  await writeFile(join(home, "a-file.md"), "not a dir");
  await symlink(join(home, "a-file.md"), join(skillsRoot, "points-to-file"));

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  assert.deepEqual(registry.skills, []);
  const codes = registry.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("INVALID_SKILL"));
  assert.equal(codes.filter((code) => code === "INVALID_SKILL").length, 2);
});

test("replaced user-level skill directory fails to load", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  await writeHomeSkill(home, "mutable-user", "Mutable.", "trusted");
  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  const skillDirectory = join(home, ".agents", "skills", "mutable-user");
  await rm(skillDirectory, { recursive: true });
  const replacement = await mkdtemp(join(tmpdir(), "user-replacement-"));
  t.after(() => rm(replacement, { recursive: true, force: true }));
  await writeFile(
    join(replacement, "SKILL.md"),
    "---\nname: mutable-user\ndescription: Mutable.\\n---\nUNTRUSTED".replace("\\n", "\n"),
  );
  await symlink(replacement, skillDirectory);

  await assert.rejects(
    registry.load("mutable-user"),
    /directory changed after discovery/,
  );
});

test("an invalid user root does not hide workspace skills", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  await writeSkill(workspace, "workspace-only", "Workspace only.");

  // 用户级 .agents 是一个文件（不是目录），应判 INVALID_SKILLS_ROOT 且不影响 workspace。
  await writeFile(join(home, ".agents"), "not a dir");

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  assert.deepEqual(registry.skills, [
    { name: "workspace-only", description: "Workspace only.", source: "workspace" },
  ]);
  assert.equal(registry.diagnostics[0]?.code, "INVALID_SKILLS_ROOT");
});

test("catalog truncation drops only the user-level tail", async (t) => {
  const workspace = await createWorkspace(t);
  const home = await createHome(t);
  await writeSkill(workspace, "ws-kept", "Workspace kept.");

  // 造 40 个超长 description 的用户级 Skill，撑爆 catalog。
  for (let index = 0; index < 40; index += 1) {
    await writeHomeSkill(
      home,
      `user-${String(index).padStart(2, "0")}`,
      `${String(index).padStart(2, "0")}-${"x".repeat(1021)}`,
    );
  }

  const registry = await discoverWorkspaceSkills(workspace, { homeDir: home });

  // workspace 条目永远保留在 catalog。
  assert.match(registry.catalog ?? "", /<name>ws-kept<\/name>/);
  assert.ok(Buffer.byteLength(registry.catalog ?? "", "utf8") <= 32 * 1024);
  assert.equal(registry.diagnostics.at(-1)?.code, "CATALOG_TRUNCATED");
  assert.match(registry.diagnostics.at(-1)?.message ?? "", /user-/);
  // 被裁掉的是 user-39（字母序最大的用户级条目）。
  assert.match(
    registry.diagnostics.at(-1)?.message ?? "",
    /user-39/,
  );
});
