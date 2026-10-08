import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { Outline, SubfolderSuggestion } from "../types";
import type { Approver } from "../flows/researchFlow";
import { selectApproved, type SuggestionRow } from "./selection";

export { selectApproved };

export class SuggestionModal extends Modal implements Approver {
  private resolve: ((v: SubfolderSuggestion[] | null) => void) | null = null;
  private outline: Outline | null = null;
  private rows: SuggestionRow[] = [];

  constructor(app: App) {
    super(app);
  }

  approve(outline: Outline): Promise<SubfolderSuggestion[] | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.outline = outline;
      this.rows = outline.subfolders.map((s) => ({ suggestion: s, name: s.name, checked: true }));
      this.open();
    });
  }

  private settle(v: SubfolderSuggestion[] | null): void {
    const r = this.resolve;
    this.resolve = null;
    r?.(v);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`Research: ${this.outline?.topic ?? ""}`);
    contentEl.createEl("p", { text: this.outline?.summary ?? "" });

    const buttons = createDiv({ cls: "modal-button-container" });
    const createBtn = buttons.createEl("button", { text: "Create", cls: "mod-cta" });
    const refresh = () => { createBtn.disabled = !this.rows.some((r) => r.checked); };

    for (const row of this.rows) {
      const wrap = contentEl.createDiv({ cls: "setting-item" });
      const info = wrap.createDiv({ cls: "setting-item-info" });
      const line = info.createDiv();
      const box = line.createEl("input", { type: "checkbox" });
      box.checked = row.checked;
      box.addEventListener("change", () => { row.checked = box.checked; refresh(); });
      const nameInput = line.createEl("input", { type: "text" });
      nameInput.value = row.name;
      nameInput.addEventListener("input", () => { row.name = nameInput.value; });
      info.createDiv({ cls: "setting-item-description", text: row.suggestion.why });
    }

    contentEl.appendChild(buttons);
    createBtn.addEventListener("click", () => {
      this.settle(selectApproved(this.rows));
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
