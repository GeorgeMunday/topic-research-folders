// Pure: the menu behind the ribbon button and the status bar item. No `obsidian` import.

export interface RibbonActions {
  review(): void;
  cancelAll(): void;
  openSettings(): void;
}

export interface MenuItem { label: string; run: () => void }

/** The three entries, always in this order. An action that throws never escapes the menu. */
export function ribbonItems(a: RibbonActions, onError: (e: unknown) => void = () => {}): MenuItem[] {
  const safe = (f: () => void) => () => { try { f(); } catch (e) { onError(e); } };
  return [
    { label: "Review pending suggestions", run: safe(a.review) },
    { label: "Cancel all research jobs", run: safe(a.cancelAll) },
    { label: "Settings", run: safe(a.openSettings) },
  ];
}
