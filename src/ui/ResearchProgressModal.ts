import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { Outline, Progress, SubfolderSuggestion } from "../types";
import type { Approver } from "../flows/researchFlow";
import { selectApproved, type SuggestionRow } from "./selection";
import { initialState, reduce, progressFraction, summaryText, writingText, itemText, type ModalState } from "./progressModel";

export interface ProgressModalHooks { onCancel: () => void; onRetry: () => void; }

export class ResearchProgressModal extends Modal implements Approver {
  private state: ModalState;
  private isOpen = false;
  private resolve: ((v: SubfolderSuggestion[] | null) => void) | null = null;
  private rows: SuggestionRow[] = [];
  private forced = false;

  constructor(app: App, topic: string, private hooks: ProgressModalHooks) {
    super(app);
    this.state = initialState(topic);
  }

  handle(e: Progress): void {
    this.state = reduce(this.state, e);
    if (this.isDone()) this.settle(null);
    if (this.isOpen) this.render();
  }

  private closeIfOpen(): void {
    if (this.isOpen) this.close();
  }

  isDone(): boolean {
    const p = this.state.phase;
    return p === "done" || p === "failed" || p === "cancelled";
  }

  forceClose(): void {
    this.forced = true;
    this.settle(null);
    this.closeIfOpen();
  }

  approve(outline: Outline, _jobPath: string): Promise<SubfolderSuggestion[] | null> {
    return new Promise((resolve) => {
      if (this.forced) { resolve(null); return; }
      this.settle(null); // never leave an earlier promise pending
      this.resolve = resolve;
      this.rows = outline.subfolders.map((s) => ({ suggestion: s, name: s.name, checked: true }));
      this.state = reduce(this.state, { kind: "outline", outline });
      if (this.isOpen) this.render(); else this.open();
    });
  }

  private settle(v: SubfolderSuggestion[] | null): void {
    const r = this.resolve;
    this.resolve = null;
    r?.(v);
  }

  onOpen(): void {
    this.isOpen = true;
    this.render();
  }

  onClose(): void {
    this.isOpen = false;
    this.contentEl.empty();
    this.settle(null);
  }

  private render(): void {
    const s = this.state;
    const { contentEl } = this;
    if (s.phase === "cancelled") { this.closeIfOpen(); return; }
    contentEl.empty();
    const buttons = createDiv({ cls: "modal-button-container" });

    if (s.phase === "loading") {
      this.titleEl.setText(`Researching ${s.topic}…`);
      const status = contentEl.createDiv({ cls: "trf-spinner" });
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      contentEl.createEl("p", { text: s.step, cls: "trf-muted" }).setAttribute("aria-live", "polite");
      buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => { this.hooks.onCancel(); this.closeIfOpen(); });
    } else if (s.phase === "choose") {
      this.titleEl.setText(`Research: ${s.outline?.topic ?? s.topic}`);
      contentEl.createEl("p", { text: s.outline?.summary ?? "" });
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
      createBtn.addEventListener("click", () => {
        const approved = selectApproved(this.rows);
        this.state = reduce(this.state, { kind: "approved", names: approved.map((a) => a.name) });
        this.settle(approved);
        this.render();
      });
      buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => { this.settle(null); this.closeIfOpen(); });
      refresh();
    } else if (s.phase === "writing") {
      this.titleEl.setText(`Researching ${s.topic}…`);
      const bar = contentEl.createDiv({ cls: "trf-progress" });
      const pct = Math.round(progressFraction(s) * 100);
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(pct));
      bar.style.setProperty("--trf-progress", String(pct));
      bar.createDiv();
      contentEl.createEl("p", { text: writingText(s) });
      const list = contentEl.createEl("ul");
      for (const it of s.items) {
        list.createEl("li", { text: itemText(it), cls: `trf-item-${it.status}` });
      }
      buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.closeIfOpen());
    } else if (s.phase === "done") {
      this.titleEl.setText(`Researched ${s.topic}`);
      contentEl.createEl("p", { text: summaryText(s) });
      buttons.createEl("button", { text: "Close", cls: "mod-cta" }).addEventListener("click", () => this.closeIfOpen());
    } else {
      this.titleEl.setText(`Research failed: ${s.topic}`);
      contentEl.createEl("p", { text: s.error ?? "Unknown error", cls: "trf-error" });
      buttons.createEl("button", { text: "Retry", cls: "mod-cta" }).addEventListener("click", () => { this.hooks.onRetry(); this.closeIfOpen(); });
      buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.closeIfOpen());
    }
    contentEl.appendChild(buttons);
  }
}
