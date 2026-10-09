<p align="center"><img src="assets/icon.svg" width="72" alt="Topic Research Folders icon"></p>

# Topic Research Folders

Add `+` to a folder or PDF name and get easy-to-read notes on it, sorted into numbered subfolders, with sources, code examples and quiz files.

## What it does

- Turns a folder named `Topic+` into subfolders of short notes, written in plain words and researched with the Anthropic API.
- Reads a PDF named `paper+.pdf` and turns its five key ideas into researched notes, linked from an overview with page references.
- Reads the folders above and next to the topic, so `c#/intro+` is researched as "Introduction to C#", at the right level and without repeating what you already have.
- Numbers the subfolders in the order to study them, and lists the real web pages (or the PDF) each note came from under **Sources**.
- Adds a section that suits the subject: code examples for programming, formulas for maths, a timeline for history, and so on.
- Writes a `Questions` file and an `Answers` file beside every set of notes, so you can test yourself.
- Works in the background: a small icon next to the folder shows the state, and nothing pops up while you write.
- Can undo a whole run: everything it created goes to the trash, and anything you edited stays.

## How to use

### `Topic+` folders

Create a folder whose name ends in `+`, for example `Black holes+`. The plugin removes the `+`, asks Claude for an outline and works in the background.

### The icon next to the name

One small icon in the file explorer shows where each folder or PDF is:

| Icon | Meaning | Click |
|---|---|---|
| Spinner | Researching | nothing |
| Sparkle (accent colour) | Suggestions are ready | opens the review pop-up (tooltip: "Suggestions ready — click to review") |
| Check | Finished; fades away after 3 seconds | nothing |
| Warning (muted) | It failed; hover for the reason | retries |

The folder's right-click menu also offers **Review suggestions** or **Retry research** for the matching state. If the explorer is closed, the status bar shows "✦ 1 ready to review"; click it to open the review. You can also run **Review pending suggestions** from the command palette or the ribbon icon. Pending suggestions survive a restart. **Cancel all research jobs** (ribbon icon, status bar or command palette) stops everything and clears the icons.

### The review pop-up

The pop-up shows the folder it is for ("Inside: c# › intro") and the topic it understood, which you can edit and **Re-suggest** if the suggestions are off. Then:

- tick the folders you want, or use **Select all** / **Select none**;
- rename a folder in its full-width field;
- reorder with the drag handle or the ↑/↓ buttons;
- press **+ Add your own folder** for one the model did not suggest (empty names are ignored).

**Enter** creates (unless you are typing in a field) and **Esc** cancels. Closing the pop-up cancels that job.

### Numbered folders and the Study path

Claude lists the subfolders simplest first. With **Number folders in learning order** on (the default), the folders you create are prefixed in the order shown in the pop-up, after your reordering: `01 - What is C sharp`, `02 - Variables and Types`. The Overview note lists them as a numbered **Study path**.

### `paper+.pdf` files

Rename `paper.pdf` to `paper+.pdf` (`paper.pdf+` works as well). The plugin renames it back to `paper.pdf`, reads it and writes `paper - Overview.md` with at most five key points, each with a page reference such as (p. 4). Every key point becomes its own subfolder of notes, researched as a separate background job. Inside a research folder the notes join the matching subfolder; anywhere else they go into a new folder `paper/` next to the PDF. A very large PDF asks for confirmation first.

### Nested topics and folder context

Create `Topic+` inside a folder to go deeper, up to the nesting depth in the settings. Every job sends the **folder context** with the request:

- the path of folders above the topic, such as University > Year 2 > Computer Science > Rust, with the folder name read as part of them;
- for each researched folder above it, the one-line summary from its Overview and its subfolder names;
- the folders next to the topic, so suggestions do not repeat them.

The context is trimmed to 2,000 characters, keeping the nearest folders. The subject of a topic (`coding`, `maths`, `science`, `language`, `history` or `general`) is decided from the resolved topic and saved as `subject:` (and `codeLanguage:` for code) in the Overview's frontmatter. Nested topics and PDFs inherit it; edit `subject:` and your value is used for later jobs.

### Sources

When web search is on, each note ends with a **Sources** section: up to five pages the search really returned, as links. Notes made from a PDF list the PDF and its pages instead, such as `[[paper.pdf]] (p. 3–5)`. If there is nothing real to cite, the section is left out.

### Undo

Run **Undo last research** from the command palette, or right-click a researched folder and choose **Undo this research**. A pop-up lists what will happen ("Delete 6 folders and 24 notes created on 9 Oct?"), and everything goes to the system trash, so you can restore it. Only items the run created are touched; a note you edited since, and any folder that still holds your own files, stay. The `+` rename is reversed only if the folder is then empty. The last 20 runs are remembered.

Re-triggering a folder that is already researched shows a short notice; run **Research this folder** (command palette or the folder's context menu) to run it again.

## Example output

Running `Rust+` inside `Programming/`, and accepting a subfolder called Ownership:

```
Programming/
└── Rust/
    ├── Rust - Overview.md
    └── 01 - Ownership/
        ├── 01 - Ownership - Questions.md
        ├── 01 - Ownership - Answers.md
        ├── Moves.md
        ├── Borrowing.md
        └── Lifetimes.md
```

`Rust - Overview.md` lists the folders in study order:

```markdown
## Study path

1. **01 - Ownership**
  - [[Programming/Rust/01 - Ownership/Moves|Moves]]
```

`Moves.md`, a coding note:

````markdown
---
topic: "Rust"
subtopic: "Ownership"
created: 2026-10-09
tags: [research]
---

# Moves

> Assigning a value to a new variable moves ownership instead of copying it.

## Key points
- Every value has exactly one owner
- Assigning a String to a new variable moves it

## In plain words
Think of a toy that only one child can hold at a time. If you hand it over, you no longer have it.

## Code examples

```rust
// A move hands ownership to `b`, so `a` can no longer be used
let a = String::from("hello");
let b = a;
println!("{}", b);
```

## Common mistakes
- Using a variable after it was moved
- Cloning everything to silence the compiler

## My notes

- 

## Sources

- [Understanding Ownership](https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html)
````

`Questions` holds five to eight numbered questions with no answers and an empty "My questions" section for your own. `Answers` has the answers in the same order, each linking the note it comes from, and links back to the questions. Other subjects get their own section instead of code: formulas and a worked example, key terms, a vocabulary table, or a timeline and key people. Code blocks use the language's fence tag (`csharp`, `rust`, …) so Obsidian highlights them.

## Tips

- Name folders inside a parent topic: `c#/intro+` researches "Introduction to C#", not introductions in general. Generic names like `intro`, `basics`, `overview`, `week 1` or `exercises` lean entirely on their parents.
- If the suggestions are still off, edit the topic in the pop-up and press **Re-suggest**; you do not need to delete the folder.
- Reorder or add folders in the pop-up before pressing Create: the numbers follow your final order.
- Put a PDF inside a researched folder to add its key points to that topic.
- Tried something you do not like? **Undo last research** takes it back to the trash.

## Settings

- **Anthropic API key**: your key, stored unencrypted in the plugin's `data.json`.
- **Model**: pick from the models your key can use, loaded from Anthropic; models without PDF or web search support are greyed out.
- **Use web search**: let Claude search the web while researching (this is where Sources come from).
- **Number folders in learning order**: prefix created folders with `01 - `, `02 - `… in the order shown in the pop-up.
- **Trigger suffix**: the ending that starts research, `+` by default.
- **Remove suffix from folder or PDF name**: drop the suffix once research starts.
- **Subfolders per topic**: the most subfolders Claude may suggest.
- **Notes per subfolder**: how many notes to write in each subfolder.
- **Maximum nesting depth**: how many levels of researched folders are allowed.
- **Concurrent jobs**: how many research or PDF jobs run at once.
- **Retries**: retries after rate limits or server errors.
- **Analyse PDFs**: turn the `paper+.pdf` trigger on or off.
- **Pages per PDF chunk**: large PDFs are sent in chunks of this many pages.
- **Confirm above pages**: ask before analysing a single PDF with more pages than this.

## Install

**From Obsidian:** once the plugin is listed, open Settings → Community plugins → Browse, search for "Topic Research Folders", then Install and Enable.

**From a release:** download `main.js`, `manifest.json` and `styles.css` (or the zip) from the [latest release](https://github.com/GeorgeMunday/topic-research-folders/releases/latest) and copy them into `<your vault>/.obsidian/plugins/topic-research-folders/` (create the folder if needed), then enable the plugin under Settings → Community plugins. With the BRAT plugin you can instead add `GeorgeMunday/topic-research-folders` and get updates automatically.

**From source:** run `npm install`, `npm test` and `npm run build`, then copy the same three files. To publish a new version, change the version in `manifest.json`, `package.json` and `versions.json`, add a line to `CHANGELOG.md`, and push a tag with that version (for example `0.1.1`): a GitHub Action tests, builds and creates the release.

Bugs and ideas: [open an issue](https://github.com/GeorgeMunday/topic-research-folders/issues).

## API key and cost

The plugin uses your own Anthropic API key and you pay Anthropic for what it uses. Each research run makes one outline request and then one request per subfolder you accept; the notes, the extra section and the quiz come back in that one request. Re-suggesting makes another outline request. Web search and large PDFs cost more, because a PDF is sent in chunks and every key point is then researched on its own. A PDF with more pages than **Confirm above pages** asks for confirmation before anything is sent. Check your usage in the Anthropic console.

## Privacy

The plugin sends the PDF content, the topic and folder names (including the folder context described above and, for research folders, the one-line summary from the Overview) to the Anthropic API, together with your API key. If web search is on, Anthropic performs the searches. Nothing else is sent anywhere, and the plugin has no analytics. The record of what each run created, used by Undo, stays in the plugin's `data.json`.

## Troubleshooting

- **The trigger suffix cannot be `*`.** Obsidian and most file systems do not allow `*` in folder or file names, so the settings refuse it (along with `"`, `\`, `/`, `<`, `>`, `:`, `|` and `?`). Use `+`, or a short word or symbol such as `=` or `~`.
- **"Model unavailable".** The saved model is no longer offered to your API key. Open the plugin settings, choose another model from the list and save. Models marked "(no PDF support)" cannot analyse PDFs, and "(no web search)" models cannot be used while **Use web search** is on.
- **An icon never goes away.** A sparkle waits for you: click it, or use **Review pending suggestions**. A spinner that stays with no job running: run **Cancel all research jobs** from the ribbon icon, the status bar or the command palette, which clears every icon and queued job, then trigger the folder again.
- **Nothing happens when I add `+`.** Check that an API key is set, that the plugin is enabled and that the folder is not already researched (use **Research this folder** to run it again).
- **Undo kept some items.** Notes you edited, and folders that still hold your own files, are never deleted; the pop-up says how many will stay.

## Licence

MIT, see [LICENSE](LICENSE).
