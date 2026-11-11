// HTML 到可读文本的轻量转换器。目标是「够用的 Markdown 味道文本」，不是
// 标准 Markdown。输入是 HTML 字符串；baseUrl 用于把 <a href> 的相对链接
// 补全成绝对 URL。

const SKIP_TAG_NAMES = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
]);

const BLOCK_TAG_NAMES = new Set([
  "p",
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "nav",
  "main",
  "blockquote",
  "address",
  "figure",
  "figcaption",
  "details",
  "summary",
  "dl",
  "dd",
  "dt",
  "ul",
  "ol",
  "form",
  "fieldset",
  "table",
  "caption",
  "colgroup",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

type NodeType = "text" | "element";

interface TextNode {
  readonly type: "text";
  value: string;
}

interface ElementNode {
  readonly type: "element";
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly rawText?: string;
  readonly children: Node[];
}

type Node = TextNode | ElementNode;

interface Renderer {
  text(text: string, inPre: boolean): void;
  block(): void;
}

export function htmlToText(html: string, baseUrl?: string): string {
  const lines: string[] = [];
  let current = "";

  const renderer: Renderer = {
    text(text, inPre) {
      current += inPre ? text : collapseWhitespace(text);
    },
    block() {
      if (current.trim() === "") {
        current = "";
        return;
      }
      lines.push(current);
      current = "";
    },
  };

  const nodes = parse(html);
  renderNodes(nodes, baseUrl ?? "", renderer);

  if (current.trim() !== "") lines.push(current);
  return lines.join("\n");
}

function renderNodes(
  nodes: readonly Node[],
  baseUrl: string,
  renderer: Renderer,
  inPre = false,
): void {
  for (const node of nodes) {
    if (node.type === "text") {
      renderer.text(node.value, inPre);
      continue;
    }
    const name = node.name.toLowerCase();

    if (SKIP_TAG_NAMES.has(name)) continue;

    if (name === "head") {
      const title = node.children.find(
        (child): child is ElementNode =>
          child.type === "element" && child.name.toLowerCase() === "title",
      );
      if (title !== undefined && title.rawText !== undefined) {
        renderer.text(decodeEntities(title.rawText), false);
        renderer.block();
      }
      continue;
    }
    if (name === "title") continue;

    if (name === "pre") {
      renderer.text(decodeEntities(node.rawText ?? ""), true);
      renderer.block();
      continue;
    }
    if (name === "textarea") continue;

    if (name === "br" || name === "hr") {
      renderer.block();
      continue;
    }

    if (name === "a") {
      const text = inlineText(node.children);
      const href = node.attrs["href"];
      const resolved = href === undefined
        ? undefined
        : resolveUrl(baseUrl, decodeEntities(href));
      if (resolved !== undefined && text !== "") {
        renderer.text(`${text} (${resolved})`, inPre);
      } else {
        renderer.text(text, inPre);
      }
      continue;
    }

    if (name === "li") {
      renderer.block();
      renderer.text("- ", false);
      renderNodes(node.children, baseUrl, renderer, inPre);
      renderer.block();
      continue;
    }

    const level = headingLevelOf(name);
    if (level > 0) {
      renderer.block();
      renderer.text(`${"#".repeat(level)} `, false);
      renderNodes(node.children, baseUrl, renderer, inPre);
      renderer.block();
      continue;
    }

    if (BLOCK_TAG_NAMES.has(name)) {
      renderer.block();
      renderNodes(node.children, baseUrl, renderer, inPre);
      renderer.block();
      continue;
    }

    renderNodes(node.children, baseUrl, renderer, inPre);
  }
}

function inlineText(nodes: readonly Node[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value;
    } else if (node.type === "element") {
      out += inlineText(node.children);
    }
  }
  return collapseWhitespace(out).trim();
}

function headingLevelOf(name: string): number {
  if (name.length === 2 && name[0] === "h") {
    const digit = Number(name[1]);
    if (digit >= 1 && digit <= 6) return digit;
  }
  return 0;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function resolveUrl(base: string, href: string): string | undefined {
  if (href.startsWith("javascript:") || href.startsWith("mailto:") ||
    href.startsWith("tel:")) {
    return undefined;
  }
  try {
    return new URL(href, base === "" ? undefined : base).toString();
  } catch {
    return undefined;
  }
}

function parse(html: string): Node[] {
  const root: ElementNode = {
    type: "element",
    name: "#root",
    attrs: {},
    children: [],
  };
  const stack: ElementNode[] = [root];
  let index = 0;

  const rawTextTags = new Set(["script", "style", "pre", "textarea", "title"]);

  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      pushText(stack.at(-1), html.slice(index));
      break;
    }
    if (open > index) pushText(stack.at(-1), html.slice(index, open));

    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", open)) {
      const close = html.indexOf("]]>", open + 9);
      pushText(
        stack.at(-1),
        close === -1 ? html.slice(open + 9) : html.slice(open + 9, close),
      );
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    const nextChar = html[open + 1];
    if (nextChar === "!" || nextChar === "?") {
      const close = html.indexOf(">", open);
      index = close === -1 ? html.length : close + 1;
      continue;
    }
    if (nextChar === "/") {
      const close = html.indexOf(">", open);
      const raw = html.slice(open + 2, close === -1 ? html.length : close)
        .trim();
      const name = raw.split(/\s/)[0]!.toLowerCase();
      index = close === -1 ? html.length : close + 1;
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const close = html.indexOf(">", open);
    const tagContent = html.slice(open + 1, close === -1 ? html.length : close);
    const tagEnd = close === -1 ? html.length : close;
    const selfClosing = tagContent.endsWith("/");
    const trimmed = selfClosing ? tagContent.slice(0, -1) : tagContent;
    const space = trimmed.search(/\s/);
    const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();

    if (name === "") {
      index = tagEnd + 1;
      continue;
    }

    const attrs = parseAttrs(trimmed);

    if (selfClosing) {
      const element: ElementNode = { type: "element", name, attrs, children: [] };
      stack.at(-1)!.children.push(element);
      index = tagEnd + 1;
      continue;
    }

    if (rawTextTags.has(name)) {
      const lower = html.toLowerCase();
      const closeTag = `</${name}`;
      const rawClose = lower.indexOf(closeTag, tagEnd + 1);
      const rawText = decodeEntities(
        rawClose === -1 ? html.slice(tagEnd + 1) : html.slice(tagEnd + 1, rawClose),
      );
      const element: ElementNode = {
        type: "element",
        name,
        attrs,
        children: [],
        rawText,
      };
      stack.at(-1)!.children.push(element);
      index = rawClose === -1 ? html.length : rawClose;
      continue;
    }

    const element: ElementNode = { type: "element", name, attrs, children: [] };
    stack.at(-1)!.children.push(element);
    stack.push(element);
    index = tagEnd + 1;
  }

  return root.children;
}

function pushText(parent: ElementNode | undefined, text: string): void {
  if (parent === undefined) return;
  const decoded = decodeEntities(text);
  const last = parent.children.at(-1);
  if (last !== undefined && last.type === "text" &&
    (last as { value: string }).value !== undefined) {
    (last as { value: string }).value += decoded;
  } else {
    parent.children.push({ type: "text", value: decoded });
  }
}

function parseAttrs(tagContent: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = tagContent.replace(/^[^\s/=]+/, "").trim();
  const regex = /([^\s=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || name === "") continue;
    attrs[name] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? "");
  }
  return attrs;
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = parseInt(entity.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      if (entity.startsWith("#")) {
        const code = parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITY_MAP[entity] ?? whole;
    },
  );
}
