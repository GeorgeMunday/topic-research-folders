<p align="center"><img src="assets/icon.svg" width="72" alt="Topic Research Folders icon"></p>

# Topic Research Folders

Add `+` to a folder or PDF name and get easy-to-read notes on it, sorted into subfolders, with code examples and quiz files.

## What it does

- Turns a folder named `Topic+` into subfolders of short notes, written in plain words and researched with the Anthropic API.
- Reads a PDF named `paper+.pdf` and turns its five key ideas into researched notes, linked from an overview with page references.
- Looks at the folders above and next to the topic, so the notes match the level of your vault and do not repeat what is already there.
- Adds a section that suits the subject: code examples for programming, formulas for maths, a timeline for history, and so on.
- Writes a `Questions` file and an `Answers` file beside every set of notes, so you can test yourself.
- Works in the background: a small spinner shows next to the folder and you can keep writing.

## How to use

### `Topic+` folders

Create a folder whose name ends in `+`, for example `Black holes+`. The plugin removes the `+`, asks Claude for an outline and shows a spinner next to the folder while it works.

### `paper+.pdf` files

Rename `paper.pdf` to `paper+.pdf` (`paper.pdf+` works as well). The plugin renames it back to `paper.pdf`, reads it and writes `paper - Overview.md` with at most five key points, each with a page reference such as (p. 4). Every key point becomes its own subfolder of notes, researched as a separate background job. Inside a research folder the notes join the matching subfolder; anywhere else they go into a new folder `paper/` next to the PDF. A very large PDF asks for confirmation first.

### The Review notice

When the suggestions for a folder are ready, a notice says "Suggestions ready for Black holes" with a **Review** button. Tick the subfolders you want and press **Create**. Closing the dialog cancels that job. If you miss the notice, run **Review pending suggestions** from the command palette, the ribbon icon or the status bar. Pending suggestions survive a restart.

Re-triggering a folder that is already researched shows a notice; run **Research this folder** (command palette or the folder's context menu) to run it again.

### Nested topics and folder context

Create `Topic+` inside a researched folder to go deeper, up to the nesting depth in the settings. Every job, nested or not, also reads the **folder context** and sends it with the request:

- the path of folders above the topic, such as University > Year 2 > Computer Science > Rust;
- for each researched folder above it, the one-line summary from its Overview note and its subfolder names;
- the folders next to the topic, so suggestions do not repeat them.

Claude uses this to pitch the level (a topic under "Year 2" is not written for beginners) and to fit the topic within its parents. The context is trimmed to 2,000 characters, keeping the nearest folders.

The subject of a topic (`coding`, `maths`, `science`, `language`, `history` or `general`) is decided from the topic and its context, and saved as `subject:` (and `codeLanguage:` for code) in the Overview note. Nested topics and PDFs inherit it. Edit `subject:` in the Overview's frontmatter and your value is used for later jobs.

## Example output

Running `Rust+` inside `Programming/`, and accepting a subfolder called Ownership:

```
Programming/
└── Rust/
    ├── Rust - Overview.md
    └── Ownership/
        ├── Ownership - Questions.md
        ├── Ownership - Answers.md
        ├── Moves.md
        ├── Borrowing.md
        └── Lifetimes.md
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
````

`Ownership - Questions.md` holds five to eight numbered questions with no answers and an empty "My questions" section for your own. `Ownership - Answers.md` has the answers in the same order, each linking the note it comes from, and links back to the questions. Notes have no question section of their own. Other subjects get their own section instead of code: formulas and a worked example, key terms, a vocabulary table, or a timeline and key people.

## Settings

- **Anthropic API key**: your key, stored unencrypted in the plugin's `data.json`.
- **Model**: the Claude model to use; models without PDF or web search support are greyed out.
- **Use web search**: let Claude search the web while researching.
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

Copy `main.js`, `manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/topic-research-folders/` (create the folder if needed), then enable the plugin under Settings → Community plugins. To build the files yourself, run `npm install` and `npm run build`.

## API key and cost

The plugin uses your own Anthropic API key and you pay Anthropic for what it uses. Each research run makes one outline request and then one request per subfolder you accept; the notes, the extra section and the quiz come back in that one request. Web search and large PDFs cost more, because a PDF is sent in chunks and every key point is then researched on its own. A PDF with more pages than **Confirm above pages** asks for confirmation before anything is sent. Check your usage in the Anthropic console.

## Privacy

The plugin sends the PDF content, the topic and folder names (including the folder context described above and, for research folders, the one-line summary from the Overview) to the Anthropic API, together with your API key. If web search is on, Anthropic performs the searches. Nothing else is sent anywhere, and the plugin has no analytics.

## Troubleshooting

- **The trigger suffix cannot be `*`.** Obsidian and most file systems do not allow `*` in folder or file names, so the settings refuse it (along with `"`, `\`, `/`, `<`, `>`, `:`, `|` and `?`). Use `+`, or a short word or symbol such as `=` or `~`.
- **"Model unavailable".** The saved model is no longer offered to your API key. Open the plugin settings, choose another model from the list and save. Models marked "(no PDF support)" cannot analyse PDFs, and "(no web search)" models cannot be used while **Use web search** is on.
- **The spinner never goes away.** A spinner next to a folder that stays after the notice "Suggestions ready" is normal: it waits for your review, so use **Review pending suggestions**. If it stays with no job running, run **Cancel all research jobs** from the ribbon icon, the status bar or the command palette, which clears every spinner and queued job. Then trigger the folder again.
- **Nothing happens when I add `+`.** Check that an API key is set, that the plugin is enabled and that the folder is not already researched (use **Research this folder** to run it again).

## Licence

MIT, see [LICENSE](LICENSE).
