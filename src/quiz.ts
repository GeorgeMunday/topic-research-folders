// Pure: the "<Subfolder> - Questions" and "<Subfolder> - Answers" notes. No `obsidian` import.
import { oneLine, yamlString } from "./vault/noteTemplate";

/** Names of the pair. Both files of a pair share the suffix (` (2)`, ...) so their links always match. */
export function quizFileNames(folderName: string, n = 1): { questions: string; answers: string } {
  const suffix = n > 1 ? ` (${n})` : "";
  return { questions: `${folderName} - Questions${suffix}`, answers: `${folderName} - Answers${suffix}` };
}

interface Meta { topic: string; subtopic: string; date: string; /** This file's name without .md. */ file: string; /** The other file of the pair. */ other: string; }

function frontmatter(m: Meta, tag: string): string[] {
  return ["---", `topic: ${yamlString(m.topic)}`, `subtopic: ${yamlString(m.subtopic)}`, `created: ${m.date}`, `tags: [research, ${tag}]`, "---", ""];
}

// A numbered item; later lines (a code block in a question) are indented to stay inside the list item.
function item(n: number, text: string): string {
  const [first, ...rest] = text.split("\n");
  return [`${n}. ${first.trimEnd()}`, ...rest.map((l) => (l.trim() === "" ? "" : `   ${l.trimEnd()}`))].join("\n");
}

export function renderQuestions(a: Meta & { questions: string[] }): string {
  const lines = [
    ...frontmatter(a, "questions"),
    `# ${oneLine(a.file)}`,
    "",
    ...a.questions.map((q, i) => item(i + 1, q.trim())),
    "",
    "## My questions",
    "",
    "1. ",
    "",
    `Answers: [[${a.other}]]`,
  ];
  return `${lines.join("\n")}\n`;
}

/** `link` is a ready wikilink to the note the answer comes from. */
export function renderAnswers(a: Meta & { answers: { text: string; link?: string }[] }): string {
  const lines = [
    ...frontmatter(a, "answers"),
    `# ${oneLine(a.file)}`,
    "",
    ...a.answers.map((x, i) => item(i + 1, `${oneLine(x.text)}${x.link ? ` (see ${x.link})` : ""}`)),
    "",
    "## Answers to my questions",
    "",
    `Questions: [[${a.other}]]`,
  ];
  return `${lines.join("\n")}\n`;
}
