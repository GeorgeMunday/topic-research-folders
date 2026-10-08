import type { NoteContent, Outline } from "../types";

// Wrap a value as a double-quoted YAML scalar, escaping backslashes and quotes.
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Key points that start with whitespace are nested under the previous point.
function renderKeyPoints(points: string[]): string {
  return points
    .map((p) => (/^\s/.test(p) ? `  - ${p.trim()}` : `- ${p.trim()}`))
    .join("\n");
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
    `# ${note.title}`,
    "",
    `> ${note.summary}`,
    "",
    "## Key points",
    renderKeyPoints(note.keyPoints),
    "",
    "## In plain words",
    note.plainWords,
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
  links: { subfolder: string; noteTitles: string[] }[],
  date: string,
): string {
  const why = new Map(outline.subfolders.map((s) => [s.name, s.why]));
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
    sections.push(`- **${link.subfolder}**`);
    const reason = why.get(link.subfolder);
    if (reason) sections.push(`  ${reason}`);
    for (const title of link.noteTitles) sections.push(`  - [[${title}]]`);
  }

  const body = [
    `# ${outline.topic}`,
    "",
    `> ${outline.summary}`,
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
  links: { subfolder: string; title: string }[],
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
    const titles = bySubfolder.get(link.subfolder) ?? [];
    titles.push(link.title);
    bySubfolder.set(link.subfolder, titles);
  }
  const sections: string[] = [];
  for (const [subfolder, titles] of bySubfolder) {
    sections.push(`- **${subfolder}**`);
    for (const title of titles) sections.push(`  - [[${title}]]`);
  }

  const body = [
    `# ${pdfName} - Summary`,
    "",
    `> ${summary}`,
    "",
    "## Extracted notes",
    "",
    ...sections,
    "",
    ...QA_BLOCK,
  ];
  return `${frontmatter.join("\n")}\n\n${body.join("\n")}\n`;
}
