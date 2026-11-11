import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { parseDocument } from "yaml";

import { readFilePrefix } from "./read-file-prefix.js";

const MAX_SKILL_BYTES = 64 * 1024;
const MAX_FRONTMATTER_BYTES = 16 * 1024;
const MAX_CATALOG_BYTES = 32 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillSource = "workspace" | "user";

export interface WorkspaceSkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
}

export interface WorkspaceSkillDiagnostic {
  readonly code:
    | "INVALID_SKILLS_ROOT"
    | "INVALID_SKILL"
    | "CATALOG_TRUNCATED"
    | "SKILL_SHADOWED";
  readonly path: string;
  readonly message: string;
}

export interface WorkspaceSkillRegistry {
  readonly skills: readonly WorkspaceSkillDescriptor[];
  readonly catalog: string | undefined;
  readonly diagnostics: readonly WorkspaceSkillDiagnostic[];
  /** 返回完整 SKILL.md 正文；目录是 canonical Skill 目录的绝对路径。 */
  load(name: string): Promise<{ content: string; directory: string; source: SkillSource }>;
}

interface DiscoveredSkill extends WorkspaceSkillDescriptor {
  readonly skillDirectory: string;
  readonly canonicalSkillDirectory: string;
  readonly instructionsPath: string;
}

export interface DiscoverWorkspaceSkillsOptions {
  /** 用户级 Skill 的主目录；缺省 os.homedir()，测试应指向临时目录。 */
  readonly homeDir?: string;
}

export async function discoverWorkspaceSkills(
  canonicalWorkspaceRoot: string,
  options: DiscoverWorkspaceSkillsOptions = {},
): Promise<WorkspaceSkillRegistry> {
  const diagnostics: WorkspaceSkillDiagnostic[] = [];
  const [workspaceSkills, userSkills] = await Promise.all([
    discoverSource({
      source: "workspace",
      baseDir: canonicalWorkspaceRoot,
      diagnostics,
      allowRootSymlink: false,
    }),
    discoverSource({
      source: "user",
      baseDir: options.homeDir ?? homedir(),
      diagnostics,
      allowRootSymlink: true,
    }),
  ]);

  // 同名 workspace 覆盖 user；被覆盖的 user 条目出 SKILL_SHADOWED（不算错误）。
  const merged = mergeBySource(workspaceSkills, userSkills, diagnostics);

  // catalog：workspace 排前面，再放 user；按顺序填充直到预算用完，因此 user
  // 永远排在 workspace 之后，workspace 条目不会被 user 条目挤掉。
  const { catalog, included, omitted } = renderCatalog(merged);
  if (omitted.length > 0) {
    diagnostics.push({
      code: "CATALOG_TRUNCATED",
      path: join(options.homeDir ?? homedir(), ".agents", "skills"),
      message:
        `Skills catalog exceeded ${MAX_CATALOG_BYTES} bytes; omitted the following skill(s): ${omitted.join(", ")}.`,
    });
  }

  const activeSkills = included;
  const skillsByName = new Map(activeSkills.map((skill) => [skill.name, skill]));

  return {
    skills: activeSkills.map(({ name, description, source }) => ({
      name,
      description,
      source,
    })),
    catalog,
    diagnostics,
    async load(name: string) {
      const skill = skillsByName.get(name);
      if (skill === undefined) {
        throw new Error(`Unknown skill: ${name}`);
      }
      await assertUnchanged(skill, canonicalWorkspaceRoot, options.homeDir ?? homedir());
      const content = (await loadSkillFile(skill.instructionsPath, skill.name)).content;
      return { content, directory: skill.canonicalSkillDirectory, source: skill.source };
    },
  };
}

interface DiscoverSourceOptions {
  readonly source: SkillSource;
  readonly baseDir: string;
  readonly diagnostics: WorkspaceSkillDiagnostic[];
  readonly allowRootSymlink: boolean;
}

async function discoverSource(
  options: DiscoverSourceOptions,
): Promise<DiscoveredSkill[]> {
  const { source, baseDir, diagnostics, allowRootSymlink } = options;
  const agentsRoot = join(baseDir, ".agents");
  const skillsRoot = join(agentsRoot, "skills");

  if (!await pathExists(agentsRoot)) return [];
  if (allowRootSymlink) {
    if (!await isDirectory(agentsRoot)) {
      diagnostics.push(invalidSkillsRoot(
        agentsRoot,
        "User skills parent must be a directory.",
      ));
      return [];
    }
  } else if (!await isPlainDirectory(agentsRoot)) {
    diagnostics.push(invalidSkillsRoot(
      agentsRoot,
      "Workspace skills parent must be a regular directory.",
    ));
    return [];
  }

  if (!await pathExists(skillsRoot)) return [];
  if (allowRootSymlink) {
    if (!await isDirectory(skillsRoot)) {
      diagnostics.push(invalidSkillsRoot(
        skillsRoot,
        "User skills root must be a directory.",
      ));
      return [];
    }
  } else if (!await isPlainDirectory(skillsRoot)) {
    diagnostics.push(invalidSkillsRoot(
      skillsRoot,
      "Workspace skills root must be a regular directory.",
    ));
    return [];
  }

  const canonicalBase = await realpath(baseDir);
  const canonicalSkillsRoot = await realpath(skillsRoot);
  if (!allowRootSymlink && !isWithin(canonicalBase, canonicalSkillsRoot)) {
    diagnostics.push(invalidSkillsRoot(
      skillsRoot,
      "Workspace skills root must remain inside the workspace.",
    ));
    return [];
  }

  const discovered: DiscoveredSkill[] = [];
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowRootSymlink && entry.isSymbolicLink()) {
      diagnostics.push(invalidSkill(
        join(skillsRoot, entry.name),
        "Skill directories must not be symbolic links.",
      ));
      continue;
    }

    const skillDirectory = join(skillsRoot, entry.name);
    const instructionsPath = join(skillDirectory, "SKILL.md");
    try {
      if (allowRootSymlink) {
        // 用户级来源下，符号链接条目用 stat（跟随链接）判断是否最终指向目录；
        // 断链或指向文件时抛错，出 INVALID_SKILL 诊断，不静默跳过。
        if (!await isDirectoryFollowingSymlinks(skillDirectory)) {
          throw new Error("Skill path must be a directory.");
        }
      } else {
        if (!entry.isDirectory()) continue;
        if (!await isPlainDirectory(skillDirectory)) {
          throw new Error("Skill path must be a regular directory.");
        }
      }
      if (!await pathExists(instructionsPath)) continue;
      const canonicalSkillDirectory = await realpath(skillDirectory);
      if (!allowRootSymlink && !isWithin(canonicalBase, canonicalSkillDirectory)) {
        throw new Error("Skill directory must remain inside the workspace.");
      }
      const parsed = await readSkillFrontmatter(instructionsPath, entry.name);
      discovered.push({
        ...parsed,
        source,
        skillDirectory,
        canonicalSkillDirectory,
        instructionsPath,
      });
    } catch (error) {
      diagnostics.push(invalidSkill(instructionsPath, errorMessage(error)));
    }
  }
  return discovered;
}

function mergeBySource(
  workspaceSkills: readonly DiscoveredSkill[],
  userSkills: readonly DiscoveredSkill[],
  diagnostics: WorkspaceSkillDiagnostic[],
): DiscoveredSkill[] {
  const workspaceNames = new Set(workspaceSkills.map((skill) => skill.name));
  const result: DiscoveredSkill[] = [...workspaceSkills];
  for (const skill of userSkills) {
    if (workspaceNames.has(skill.name)) {
      diagnostics.push({
        code: "SKILL_SHADOWED",
        path: skill.skillDirectory,
        message:
          `User-level skill "${skill.name}" is shadowed by the workspace skill of the same name.`,
      });
      continue;
    }
    result.push(skill);
  }

  result.sort((left, right) => {
    // workspace 排前面，两侧各自按名称排序。
    if (left.source !== right.source) return left.source === "workspace" ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });

  // 去重（workspace 已覆盖 user，上面的 SKILL_SHADOWED 已剔除 user 的重名项，
  // 但为稳妥仍按 name 去重保留 workspace）。
  const seen = new Set<string>();
  const deduped: DiscoveredSkill[] = [];
  for (const skill of result) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    deduped.push(skill);
  }
  return deduped;
}

function renderCatalog(
  skills: readonly DiscoveredSkill[],
): {
  readonly catalog: string | undefined;
  readonly included: DiscoveredSkill[];
  readonly omitted: string[];
} {
  if (skills.length === 0) {
    return { catalog: undefined, included: [], omitted: [] };
  }
  const opening = "<skills>\n";
  const closing = "</skills>";
  let catalog = opening;
  const included: DiscoveredSkill[] = [];
  for (const skill of skills) {
    const entry = [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      "  </skill>\n",
    ].join("\n");
    if (
      Buffer.byteLength(catalog + entry + closing, "utf8") > MAX_CATALOG_BYTES
    ) {
      break;
    }
    catalog += entry;
    included.push(skill);
  }
  const includedNames = new Set(included.map((skill) => skill.name));
  const omitted = skills
    .filter((skill) => !includedNames.has(skill.name))
    .map((skill) => skill.name);
  return {
    catalog: included.length === 0 ? undefined : catalog + closing,
    included,
    omitted,
  };
}

async function assertUnchanged(
  skill: DiscoveredSkill,
  _workspaceRoot: string,
  _homeDir: string,
): Promise<void> {
  const currentCanonicalSkillDirectory = await realpath(skill.skillDirectory);
  if (currentCanonicalSkillDirectory !== skill.canonicalSkillDirectory) {
    throw new Error("Skill directory changed after discovery.");
  }
  const canonicalPath = await realpath(skill.instructionsPath);
  if (!isWithin(skill.canonicalSkillDirectory, canonicalPath)) {
    throw new Error("SKILL.md must remain inside its discovered skill directory.");
  }
}

export function reportWorkspaceSkillDiagnostics(
  diagnostics: readonly WorkspaceSkillDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    console.warn(JSON.stringify({
      event: "workspace_skill_diagnostic",
      ...diagnostic,
    }));
  }
}

async function readSkillFrontmatter(
  instructionsPath: string,
  directoryName: string,
): Promise<Omit<WorkspaceSkillDescriptor, "source">> {
  const file = await openSkillFile(instructionsPath);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error("SKILL.md must be a regular file.");
    }
    if (stats.size > MAX_SKILL_BYTES) {
      throw new Error(`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes.`);
    }
    const buffer = await readFilePrefix(
      file,
      Math.min(MAX_FRONTMATTER_BYTES, stats.size),
    );
    const frontmatter = extractFrontmatter(buffer);
    return parseSkillFrontmatter(frontmatter, directoryName);
  } finally {
    await file.close();
  }
}

async function loadSkillFile(
  instructionsPath: string,
  directoryName: string,
): Promise<{ readonly content: string }> {
  const file = await openSkillFile(instructionsPath);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error("SKILL.md must be a regular file.");
    }
    if (stats.size > MAX_SKILL_BYTES) {
      throw new Error(`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes.`);
    }
    const buffer = await readFilePrefix(file, stats.size);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error("SKILL.md must be valid UTF-8.");
    }
    parseSkillFrontmatter(extractFrontmatter(buffer), directoryName);
    return { content };
  } finally {
    await file.close();
  }
}

async function openSkillFile(instructionsPath: string): Promise<FileHandle> {
  try {
    return await open(
      instructionsPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isErrorCode(error, "ELOOP")) {
      throw new Error("SKILL.md must not be a symbolic link.");
    }
    if (isErrorCode(error, "ENOENT")) {
      throw new Error("SKILL.md does not exist.");
    }
    throw error;
  }
}

function extractFrontmatter(buffer: Buffer): string {
  const openingLength = buffer.subarray(0, 5).equals(Buffer.from("---\r\n"))
    ? 5
    : buffer.subarray(0, 4).equals(Buffer.from("---\n"))
    ? 4
    : 0;
  if (openingLength === 0) {
    throw new Error("SKILL.md must start with YAML frontmatter.");
  }

  let lineStart = openingLength;
  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(0x0a, lineStart);
    const rawLineEnd = newline === -1 ? buffer.length : newline;
    const lineEnd = rawLineEnd > lineStart && buffer[rawLineEnd - 1] === 0x0d
      ? rawLineEnd - 1
      : rawLineEnd;
    if (buffer.subarray(lineStart, lineEnd).equals(Buffer.from("---"))) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(openingLength, lineStart),
        );
      } catch {
        throw new Error("SKILL.md frontmatter must be valid UTF-8.");
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  throw new Error(
    `SKILL.md frontmatter must close within ${MAX_FRONTMATTER_BYTES} bytes.`,
  );
}

function parseSkillFrontmatter(
  frontmatter: string,
  directoryName: string,
): Omit<WorkspaceSkillDescriptor, "source"> {
  const document = parseDocument(frontmatter, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error("SKILL.md frontmatter is invalid YAML.");
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("SKILL.md frontmatter must not contain YAML aliases.");
  }
  if (!isRecord(value)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping.");
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string"
    ? value.description.trim()
    : "";
  if (name.length === 0) {
    throw new Error("Skill frontmatter must define name.");
  }
  if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      "Skill name must contain 1-64 lowercase letters, digits, or single hyphens.",
    );
  }
  if (name !== directoryName) {
    throw new Error("Skill name must match its directory name.");
  }
  if (description.length < 1 || description.length > 1024) {
    throw new Error("Skill description must contain 1-1024 characters.");
  }
  return { name, description };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function isPlainDirectory(path: string): Promise<boolean> {
  const stats = await lstat(path);
  return stats.isDirectory() && !stats.isSymbolicLink();
}

async function isDirectory(path: string): Promise<boolean> {
  const stats = await lstat(path);
  return stats.isDirectory() || stats.isSymbolicLink();
}

async function isDirectoryFollowingSymlinks(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot));
}

function invalidSkillsRoot(
  path: string,
  message: string,
): WorkspaceSkillDiagnostic {
  return { code: "INVALID_SKILLS_ROOT", path, message };
}

function invalidSkill(
  path: string,
  message: string,
): WorkspaceSkillDiagnostic {
  return { code: "INVALID_SKILL", path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
