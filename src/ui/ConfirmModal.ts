import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { Confirmer } from "../flows/pdfFlow";

export class ConfirmModal extends Modal implements Confirmer {
  private resolve: ((v: boolean) => void) | null = null;
  private message = "";

  constructor(app: App) {
    super(app);
  }

  confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.message = message;
      this.open();
    });
  }

  private settle(v: boolean): void {
    const r = this.resolve;
    this.resolve = null;
    r?.(v);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("Analyse PDFs?");
    contentEl.createEl("p", { text: this.message });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Continue", cls: "mod-cta" }).addEventListener("click", () => {
      this.settle(true);
      this.close();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    this.settle(false);
  }
}
