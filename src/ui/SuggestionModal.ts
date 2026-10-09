import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { Outline, SubfolderSuggestion } from "../types";
import type { ReviewHooks } from "./hub";
import { modalTitle, selectApproved, type SuggestionRow } from "./selection";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Lets the user pick and rename the suggested subfolders. Opened only on demand (Review button or command).
 * `choose()` resolves once: the approved list on Create, null on Cancel, Esc, the close button or close().
 * The topic field and "Re-suggest" ask for new suggestions under an edited topic without touching the folder.
 */
export class SuggestionModal extends Modal {
  private resolve: ((v: SubfolderSuggestion[] | null) => void) | null = null;
  private settled = false;
  private rows: SuggestionRow[];

  constructor(app: App, private outline: Outline, private hooks?: ReviewHooks) {
    super(app);
    this.rows = this.rowsOf(outline);
  }

  private rowsOf(o: Outline): SuggestionRow[] {
    return o.subfolders.map((s) => ({ suggestion: s, name: s.name, checked: true }));
  }

  choose(): Promise<SubfolderSuggestion[] | null> {
    return new Promise((resolve) => {
      if (this.settled) { resolve(null); return; }
      this.resolve = resolve;
      this.open();
    });
  }

  private settle(v: SubfolderSuggestion[] | null): void {
    if (this.settled) return;
    this.settled = true;
    const r = this.resolve;
    this.resolve = null;
    r?.(v);
  }

  onOpen(): void {
    this.render("");
  }

  private render(message: string, topicDraft?: string): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(modalTitle(this.hooks ? baseName(this.hooks.path) : this.outline.topic, this.outline));
    if (this.outline.summary) contentEl.createEl("p", { text: this.outline.summary });

    const resuggest = this.hooks?.resuggest;
    if (resuggest) {
      const topicRow = contentEl.createDiv({ cls: "setting-item" });
      topicRow.createDiv({ cls: "setting-item-description", text: "Topic (edit it if the suggestions are about the wrong thing)" });
      const topicInput = topicRow.createEl("input", { type: "text" });
      topicInput.value = topicDraft ?? (this.outline.resolvedTopic || this.outline.topic);
      topicInput.setAttribute("aria-label", "Topic");
      const again = topicRow.createEl("button", { text: "Re-suggest" });
      again.addEventListener("click", () => {
        const topic = topicInput.value.trim();
        if (topic === "") return;
        again.disabled = true;
        again.setText("Suggesting…");
        resuggest(topic).then(
          (o) => {
            if (this.settled) return;
            this.outline = o;
            this.rows = this.rowsOf(o);
            this.render("");
          },
          (e) => {
            if (this.settled) return;
            this.render(`Could not get new suggestions: ${e instanceof Error ? e.message : "unexpected error"}`, topic);
          },
        );
      });
      if (message) contentEl.createEl("p", { text: message, cls: "mod-warning" });
    }

    const list = contentEl.createDiv();
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const createBtn = buttons.createEl("button", { text: "Create", cls: "mod-cta" });
    const refresh = () => { createBtn.disabled = !this.rows.some((r) => r.checked); };
    for (const row of this.rows) {
      const wrap = list.createDiv({ cls: "setting-item" });
      const info = wrap.createDiv({ cls: "setting-item-info" });
      const line = info.createDiv();
      const box = line.createEl("input", { type: "checkbox" });
      box.checked = row.checked;
      box.setAttribute("aria-label", `Include ${row.suggestion.name}`);
      box.addEventListener("change", () => { row.checked = box.checked; refresh(); });
      const nameInput = line.createEl("input", { type: "text" });
      nameInput.value = row.name;
      nameInput.setAttribute("aria-label", "Folder name");
      nameInput.addEventListener("input", () => { row.name = nameInput.value; });
      info.createDiv({ cls: "setting-item-description", text: row.suggestion.why });
    }
    createBtn.addEventListener("click", () => {
      const approved = selectApproved(this.rows);
      if (approved.length === 0) return;
      this.settle(approved);
      this.close();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    refresh();
  }

  onClose(): void {
    this.contentEl.empty();
    this.settle(null);
  }
}
