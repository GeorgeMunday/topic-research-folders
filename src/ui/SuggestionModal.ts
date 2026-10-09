import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { Outline, SubfolderSuggestion } from "../types";
import type { ReviewHooks } from "./hub";
import { addOwnRow, insideLine, keyAction, modalTitle, moveRow, selectApproved, setAllChecked, type SuggestionRow } from "./selection";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Lets the user pick, rename, reorder and add the suggested subfolders. Opened only on demand (Review icon or command).
 * `choose()` resolves once: the approved list (in the order shown) on Create, null on Cancel, Esc, the close button or close().
 * The topic field and "Re-suggest" ask for new suggestions under an edited topic without touching the folder.
 */
export class SuggestionModal extends Modal {
  private resolve: ((v: SubfolderSuggestion[] | null) => void) | null = null;
  private settled = false;
  private rows: SuggestionRow[];
  private listEl: HTMLElement | null = null;
  private createBtn: HTMLButtonElement | null = null;
  private dragFrom = -1;

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

  private create(): void {
    const approved = selectApproved(this.rows);
    if (approved.length === 0) return;
    this.settle(approved);
    this.close();
  }

  private render(message: string, topicDraft?: string): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(modalTitle(this.hooks ? baseName(this.hooks.path) : this.outline.topic, this.outline));
    if (this.hooks) contentEl.createDiv({ cls: "trf-suggest-inside", text: insideLine(this.hooks.path) });
    if (this.outline.summary) contentEl.createEl("p", { text: this.outline.summary });

    const resuggest = this.hooks?.resuggest;
    if (resuggest) {
      const topicRow = contentEl.createDiv({ cls: "setting-item" });
      topicRow.createDiv({ cls: "setting-item-description", text: "Topic (edit it if the suggestions are about the wrong thing)" });
      const topicInput = topicRow.createEl("input", { type: "text", cls: "trf-suggest-name" });
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

    const tools = contentEl.createDiv({ cls: "trf-suggest-tools" });
    const all = tools.createEl("a", { text: "Select all" });
    const none = tools.createEl("a", { text: "Select none" });
    all.addEventListener("click", () => { setAllChecked(this.rows, true); this.drawRows(); });
    none.addEventListener("click", () => { setAllChecked(this.rows, false); this.drawRows(); });

    this.listEl = contentEl.createDiv();
    const add = contentEl.createEl("button", { text: "+ Add your own folder", cls: "trf-suggest-add" });
    add.addEventListener("click", () => {
      addOwnRow(this.rows);
      this.drawRows(this.rows.length - 1);
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    this.createBtn = buttons.createEl("button", { text: "Create", cls: "mod-cta" });
    this.createBtn.addEventListener("click", () => this.create());
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

    // Enter = Create (not from a field or button), Esc = Cancel (Obsidian already closes the modal on Esc).
    contentEl.addEventListener("keydown", (ev) => {
      const t = ev.target as HTMLElement | null;
      const tag = t?.tagName;
      const target = tag === "BUTTON" || tag === "A" ? "button" : tag === "INPUT" && (t as HTMLInputElement).type === "text" || tag === "TEXTAREA" ? "text" : "other";
      const action = keyAction(ev.key, target);
      if (action === "create") { ev.preventDefault(); this.create(); }
      else if (action === "cancel") { ev.preventDefault(); this.close(); }
    });
    this.drawRows();
  }

  private enableCreate(): void {
    if (this.createBtn) this.createBtn.disabled = !this.rows.some((r) => r.checked);
  }

  private move(from: number, to: number): void {
    if (to < 0 || to >= this.rows.length || from === to) return;
    this.rows = moveRow(this.rows, from, to);
    this.drawRows(to);
  }

  /** Redraws the list; \`focusIndex\` puts the cursor in that row's name (after an add or a keyboard move). */
  private drawRows(focusIndex?: number): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    this.rows.forEach((row, i) => {
      const wrap = list.createDiv({ cls: "trf-suggest-row" });
      const handle = wrap.createSpan({ cls: "trf-suggest-handle", text: "⠿" });
      handle.setAttribute("aria-label", "Drag to reorder");
      // Dragging starts from the handle only, so text selection in the name field still works.
      handle.addEventListener("mousedown", () => { wrap.draggable = true; });
      wrap.addEventListener("dragstart", (ev) => { this.dragFrom = i; ev.dataTransfer?.setData("text/plain", String(i)); });
      wrap.addEventListener("dragend", () => { wrap.draggable = false; wrap.removeClass("trf-drag-over"); });
      wrap.addEventListener("dragover", (ev) => { ev.preventDefault(); wrap.addClass("trf-drag-over"); });
      wrap.addEventListener("dragleave", () => wrap.removeClass("trf-drag-over"));
      wrap.addEventListener("drop", (ev) => {
        ev.preventDefault();
        wrap.removeClass("trf-drag-over");
        const from = this.dragFrom;
        this.dragFrom = -1;
        if (from >= 0) this.move(from, i);
      });

      const body = wrap.createDiv({ cls: "trf-suggest-body" });
      const line = body.createDiv({ cls: "trf-suggest-line" });
      const box = line.createEl("input", { type: "checkbox" });
      box.checked = row.checked;
      box.setAttribute("aria-label", `Include ${row.suggestion.name || "your folder"}`);
      box.addEventListener("change", () => { row.checked = box.checked; this.enableCreate(); });
      const nameInput = line.createEl("input", { type: "text", cls: "trf-suggest-name" });
      nameInput.value = row.name;
      nameInput.setAttribute("aria-label", "Folder name");
      if (row.suggestion.name === "") nameInput.placeholder = "Folder name";
      nameInput.addEventListener("input", () => { row.name = nameInput.value; });
      if (row.suggestion.why) body.createDiv({ cls: "setting-item-description", text: row.suggestion.why });
      if (focusIndex === i) window.setTimeout(() => nameInput.focus(), 0);

      const move = wrap.createDiv({ cls: "trf-suggest-move" });
      const up = move.createEl("button", { text: "↑" });
      up.setAttribute("aria-label", "Move up");
      up.disabled = i === 0;
      up.addEventListener("click", () => this.move(i, i - 1));
      const down = move.createEl("button", { text: "↓" });
      down.setAttribute("aria-label", "Move down");
      down.disabled = i === this.rows.length - 1;
      down.addEventListener("click", () => this.move(i, i + 1));
    });
    this.enableCreate();
  }

  onClose(): void {
    this.contentEl.empty();
    this.settle(null);
  }
}
