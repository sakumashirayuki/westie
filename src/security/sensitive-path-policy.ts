import path from "node:path";

const SAFE_DOTENV_NAMES = new Set([
  ".env.defaults",
  ".env.dist",
  ".env.example",
  ".env.sample",
  ".env.schema",
  ".env.template",
]);

const SENSITIVE_EXACT_NAMES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "application_default_credentials.json",
  "credentials.tfrc.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "kubeconfig",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pfx",
]);

const SENSITIVE_RELATIVE_SUFFIXES = [
  ".aws/credentials",
  ".docker/config.json",
  ".kube/config",
  ".terraform.d/credentials.tfrc.json",
] as const;

export function isSensitiveWorkspacePath(
  workspaceRoot: string,
  candidate: string,
): boolean {
  const relativePath = path.relative(
    path.resolve(workspaceRoot),
    path.resolve(candidate),
  );
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return false;
  }

  const portablePath = relativePath.split(path.sep).join("/").toLowerCase();
  const name = path.posix.basename(portablePath);

  if (
    (name === ".env" || name.startsWith(".env.")) &&
    !SAFE_DOTENV_NAMES.has(name)
  ) {
    return true;
  }
  if (SENSITIVE_EXACT_NAMES.has(name)) return true;
  if (SENSITIVE_EXTENSIONS.has(path.posix.extname(name))) return true;
  if (
    name.endsWith(".pem") &&
    (name.includes("private") || name.includes("key"))
  ) {
    return true;
  }
  if (/^(?:client_secret|service-account)[^/]*[.]json$/.test(name)) {
    return true;
  }
  if (/^secrets?[.](?:json|ya?ml|toml)$/.test(name)) return true;

  return SENSITIVE_RELATIVE_SUFFIXES.some(
    (suffix) =>
      portablePath === suffix ||
      portablePath.endsWith(`/${suffix}`),
  );
}

export function createSensitiveWorkspacePathRegexes(): readonly string[] {
  return [
    `/${caseInsensitiveLiteral(".env")}([.][^/]*)?$`,
    ...[...SENSITIVE_EXACT_NAMES].map(
      (name) => `/${caseInsensitiveLiteral(name)}$`,
    ),
    `[^/]+[.](${[...SENSITIVE_EXTENSIONS]
      .map((extension) => caseInsensitiveLiteral(extension.slice(1)))
      .join("|")})$`,
    `[^/]*(${caseInsensitiveLiteral("private")}|${caseInsensitiveLiteral("key")})[^/]*${caseInsensitiveLiteral(".pem")}$`,
    `/(${caseInsensitiveLiteral("client_secret")}|${caseInsensitiveLiteral("service-account")})[^/]*${caseInsensitiveLiteral(".json")}$`,
    `/${caseInsensitiveLiteral("secret")}${caseInsensitiveLiteral("s")}?${caseInsensitiveLiteral(".")}(${[
      "json",
      "yaml",
      "yml",
      "toml",
    ].map(caseInsensitiveLiteral).join("|")})$`,
    ...SENSITIVE_RELATIVE_SUFFIXES.map(
      (suffix) => `/${caseInsensitiveLiteral(suffix)}$`,
    ),
  ];
}

export function createSafeDotenvWorkspacePathRegex(): string {
  return `/${caseInsensitiveLiteral(".env.")}(${[
    "defaults",
    "dist",
    "example",
    "sample",
    "schema",
    "template",
  ].map(caseInsensitiveLiteral).join("|")})$`;
}

function caseInsensitiveLiteral(value: string): string {
  return [...value].map((character) => {
    if (/[a-z]/i.test(character)) {
      return `[${character.toLowerCase()}${character.toUpperCase()}]`;
    }
    return character === "." ? "[.]" : character;
  }).join("");
}
