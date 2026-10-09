import type { KeyPoint, NoteContent, Outline, PdfOverview } from "../types";

// Collapse any run of whitespace (including line breaks) to one space, then trim.
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Wrap a value as a single-line double-quoted YAML scalar, escaping backslashes and quotes.
function yamlString(value: string): string {
  return `"${oneLine(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Key points that start with whitespace are nested under the previous point.
function renderKeyPoints(points: string[]): string[] {
  return points.map((p) => (/^\s/.test(p) ? `  - ${oneLine(p)}` : `- ${oneLine(p)}`));
}

// With a folder: a full-path wikilink aliased to the title (unambiguous when titles repeat); otherwise a bare link.
function noteLink(title: string, folder?: string): string {
  const t = oneLine(title);
  return folder ? `[[${oneLine(folder)}/${t}|${t}]]` : `[[${t}]]`;
}

const QA_BLOCK = ["## Questions & Answers", "", "**Q:** ", "**A:** "];

export function renderNote(
  note: NoteContent,
  ctx: { topic: string; subtopic: string; date: string; source?: string; pages?: string },
): string {
  const frontmatter = ["---", `topic: ${yamlString(ctx.topic)}`, `subtopic: ${yamlString(ctx.subtopic)}`, `created: ${ctx.date}`];
  if (ctx.source) frontmatter.push(`source: ${yamlString(`[[${ctx.source}]]`)}`);
  if (ctx.pages) frontmatter.push(`pages: ${yamlString(ctx.pages)}`);
  frontmatter.push("tags: [research]", "---");

  const body = [
    `# ${oneLine(note.title)}`,
    "",
    `> ${oneLine(note.summary)}`,
    "",
    "## Key points",
    ...renderKeyPoints(note.keyPoints),
    "",
    "## In plain words",
    oneLine(note.plainWords),
    "",
    "## My notes",
    "",
    "- ",
    "",
    ...QA_BLOCK,
  ];
  return `${frontmatter.join("\n")}\n\n${body.join("\n")}\n`;
}

export function renderOverview(
  outline: Outline,
  links: { subfolder: string; noteTitles: string[]; folder?: string }[],
  date: string,
): string {
  const why = new Map(outline.subfolders.map((s) => [s.name, oneLine(s.why)]));
  const frontmatter = [
    "---",
    `topic: ${yamlString(outline.topic)}`,
    `created: ${date}`,
    "research-root: true",
    "tags: [research]",
    "---",
  ];

  const sections: string[] = [];
  for (const link of links) {
    sections.push(`- **${oneLine(link.subfolder)}**`);
    const reason = why.get(link.subfolder);
    if (reason) sections.push(`  ${reason}`);
    for (const title of link.noteTitles) sections.push(`  - ${noteLink(title, link.folder)}`);
  }

  const body = [
    `# ${oneLine(outline.topic)}`,
    "",
    `> ${oneLine(outline.summary)}`,
    "",
    "## Subfolders",
    "",
    ...sections,
    "",
    ...QA_BLOCK,
  ];
  return `${frontmatter.join("\n")}\n\n${body.join("\n")}\n`;
}

export function renderSourceSummary(
  pdfName: string,
  topic: string,
  summary: string,
  links: { subfolder: string; title: string; folder?: string }[],
  date: string,
): string {
  const frontmatter = [
    "---",
    `topic: ${yamlString(topic)}`,
    `source: ${yamlString(`[[${pdfName}]]`)}`,
    `created: ${date}`,
    "tags: [research]",
    "---",
  ];

  const bySubfolder = new Map<string, string[]>();
  for (const link of links) {
    const targets = bySubfolder.get(link.subfolder) ?? [];
    targets.push(noteLink(link.title, link.folder));
    bySubfolder.set(link.subfolder, targets);
  }
  const sections: string[] = [];
  for (const [subfolder, targets] of bySubfolder) {
    sections.push(`- **${oneLine(subfolder)}**`);
    for (const target of targets) sections.push(`  - ${target}`);
  }

  const body = [
    `# ${oneLine(pdfName)} - Summary`,
    "",
    `> ${oneLine(summary)}`,
    "",
    "## Extracted notes",
    "",
    ...sections,
    "",
    ...QA_BLOCK,
  ];
  return `${frontmatter.join("\n")}\n\n${body.join("\n")}\n`;
}

/** The PDF overview (Stage 1): one bullet per key point linking its entry note; never padded. */
export function renderPdfOverview(
  o: { pdfName: string; overview: PdfOverview; links: { point: KeyPoint; target: string }[]; asRoot: boolean },
  date: string,
): string {
  const stem = o.pdfName.replace(/\.pdf$/i, "");
  const frontmatter = [
    "---",
    `topic: ${yamlString(stem)}`,
    `subtopic: ${yamlString("Overview")}`,
    `created: ${date}`,
    `source: ${yamlString(`[[${o.pdfName}]]`)}`,
  ];
  if (o.asRoot) frontmatter.push("research-root: true");
  frontmatter.push("tags: [research]", "---");

  // `|` and brackets would end the wikilink early.
  const alias = (s: string) => oneLine(s.replace(/[|[\]]/g, " "));
  const bullets = o.links.map((l) => `- ${oneLine(l.point.text)} → [[${oneLine(l.target)}|${alias(l.point.name)}]]`);

  const body = [
    `# ${oneLine(stem)} - Overview`,
    "",
    `> ${oneLine(o.overview.summary)}`,
    "",
    "## Key points",
    ...bullets,
    "",
    "## In plain words",
    oneLine(o.overview.plainWords),
    "",
    "## My notes",
    "",
    "- ",
    "",
    ...QA_BLOCK,
  ];
  return `${frontmatter.join("\n")}\n\n${body.join("\n")}\n`;
}
