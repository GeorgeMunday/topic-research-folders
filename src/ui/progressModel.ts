import type { Outline, Progress } from "../types";
import { CANCELLED_MESSAGE } from "../progress";

export type ModalState = {
  phase: "loading" | "choose" | "writing" | "done" | "failed" | "cancelled";
  topic: string;
  step: string;
  outline?: Outline;
  items: { name: string; status: "pending" | "working" | "ok" | "error"; error?: string }[];
  index: number;
  total: number;
  current: string;
  folders: number;
  notes: number;
  error?: string;
};
export type ModalAction = Progress | { kind: "approved"; names: string[] };

export function initialState(topic: string): ModalState {
  return { phase: "loading", topic, step: "", items: [], index: 0, total: 0, current: "", folders: 0, notes: 0 };
}

const setStatus = (s: ModalState, name: string, status: "working" | "ok" | "error", error?: string): ModalState["items"] =>
  s.items.map((it) => (it.name === name ? (error !== undefined ? { name, status, error } : { name, status }) : it));

export function reduce(s: ModalState, a: ModalAction): ModalState {
  if (s.phase === "done" || s.phase === "failed" || s.phase === "cancelled") return s;
  switch (a.kind) {
    case "step": return { ...s, step: a.text };
    case "outline": return { ...s, phase: "choose", outline: a.outline };
    case "approved":
      return { ...s, phase: "writing", items: a.names.map((name) => ({ name, status: "pending" as const })), total: a.names.length, index: 0, current: "" };
    case "writing":
      return { ...s, items: setStatus(s, a.name, "working"), index: a.index, total: a.total, current: a.name };
    case "itemDone":
      return { ...s, items: setStatus(s, a.name, a.ok ? "ok" : "error", a.ok ? undefined : a.error) };
    case "done": return { ...s, phase: "done", folders: a.folders, notes: a.notes };
    case "failed":
      return a.error === CANCELLED_MESSAGE ? { ...s, phase: "cancelled", error: a.error } : { ...s, phase: "failed", error: a.error };
  }
}

export function progressFraction(s: ModalState): number {
  if (s.total <= 0) return 0;
  const finished = s.items.filter((i) => i.status === "ok" || i.status === "error").length;
  return Math.min(1, finished / s.total);
}

export function summaryText(s: ModalState): string {
  const f = `${s.folders} ${s.folders === 1 ? "folder" : "folders"}`;
  const n = `${s.notes} ${s.notes === 1 ? "note" : "notes"}`;
  return `Done — ${f}, ${n}`;
}
