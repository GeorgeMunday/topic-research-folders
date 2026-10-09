# Topic Research Folders

An Obsidian plugin that turns a folder name or a PDF file name ending in `+` into researched notes, using the Anthropic API.

## Install

Copy these three files into `<your vault>/.obsidian/plugins/topic-research-folders/` (create the folder if needed), then enable the plugin under Settings → Community plugins:

- `main.js`
- `manifest.json`
- `styles.css`

In the plugin settings, paste your Anthropic API key and pick a model. The key is stored unencrypted in the plugin's `data.json`.

## Trigger 1: a folder ending in `+` (`Topic+`)

Create a folder such as `Black holes+`. The plugin asks Claude for an outline, shows a small spinner next to the folder in the file explorer, and keeps working in the background, so you can keep typing in other notes. When the suggestions are ready a notice says "Suggestions ready for Black holes" with a **Review** button. Review opens the suggestion dialog (the only other dialog is the confirmation for very large PDFs): tick the subfolders you want and press **Create**. Closing the dialog without Create cancels that job.

Missed the notice? Run the command **Review pending suggestions**. Pending suggestions survive a restart.

Re-triggering a folder that was already researched shows a notice; use the command **Research this folder** to run it again.

## Trigger 2: a PDF file ending in `+`

Rename `paper.pdf` to `paper+.pdf` (`paper.pdf+` works as well). The plugin renames it back to `paper.pdf` (unless "strip suffix" is off) and analyses it in two stages:

1. `paper - Overview.md` with a "Key points" section of at most 5 points, each with a page reference such as (p. 4). Fewer than 5 appear when the PDF is thin.
2. Each key point becomes its own subfolder, researched as an independent background job (with web search if enabled), with notes linked from the overview as `[[wikilinks]]`. One failing key point does not stop the others.

Where the notes go:

- Inside a research folder: into the matching subfolder, otherwise under `From PDFs`.
- Anywhere else: a new folder `paper/` next to the PDF.

A PDF is only processed when you add the `+`. Moving a file already named `paper+.pdf` into the vault does nothing until it is renamed. A very large PDF (over the "confirm above pages" setting) asks for confirmation first.

## Status bar and cancelling

The status bar shows progress ("Researching Black holes…", "Analysing paper.pdf (chunk 2/6)…"). Click it and choose **Cancel all research jobs** (also available as a command).

## Settings

API key, model (models that lack PDF or web search support are greyed out), web search on/off, trigger suffix, strip suffix, subfolders and notes per subfolder, depth, concurrency, retries, PDF analysis on/off, pages per chunk, and the page count above which a PDF asks for confirmation.

## Cost

Every research run makes several API calls, and web search and PDF analysis cost extra. Large PDFs are split into chunks, each one a separate request. Check your usage on the Anthropic console.

## Caveats

- If you change the suffix to a word instead of `+`, any folder or PDF whose name ends with those letters triggers.
- A cancelled job that is already running may still finish a request that was in flight.
