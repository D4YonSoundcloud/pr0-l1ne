/**
 * The keys that work anywhere on the page outside the editor (inside it,
 * Monaco handles its own, including the same commands):
 * - Ctrl + ': Run; Ctrl + Shift + ': Measure
 * - Ctrl/Cmd + S: Save; Ctrl/Cmd + Shift + S: Save as (never the browser's "Save page")
 * - the stepping keys (PlaybackController.handleKey): arrows, Home / End, Space, F10, Ctrl/Cmd + Enter
 */
export interface ShortcutActions {
  run(): void;
  measure(): void;
  save(): void;
  saveAs(): void;
  /** The save dialog is open: its fields get the keys. */
  dialogOpen(): boolean;
  /** The stepping keys; returns true when it handled the key. */
  step(event: KeyboardEvent): boolean;
}

/** Handle a keydown on the page. Returns true when it was a shortcut. */
export function handleShortcut(event: KeyboardEvent, actions: ShortcutActions): boolean {
  const target = event.target as HTMLElement | null;
  // Inside the editor, Monaco handles its own keys (including F10 / Shift+F10).
  if (target?.closest?.(".monaco-editor")) return false;

  // Ctrl + ' runs, and Ctrl/Cmd + Enter plays (or goes back to where
  // playing started), from anywhere on the page, not just the editor.
  if (event.ctrlKey && (event.code === "Quote" || event.key === "'" || event.key === '"')) {
    event.preventDefault();
    if (event.shiftKey) actions.measure();
    else actions.run();
    return true;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") return actions.step(event);

  // Save works from anywhere, and should never open the browser's "Save page".
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!actions.dialogOpen()) {
      if (event.shiftKey) actions.saveAs();
      else actions.save();
    }
    return true;
  }
  if (actions.dialogOpen()) return false;

  // Stepping and playing: arrows, Home / End, Space, F10.
  return actions.step(event);
}

/** Listen for the shortcuts on the whole page. */
export function installShortcuts(actions: ShortcutActions, doc: Document = document): void {
  doc.addEventListener("keydown", (event) => void handleShortcut(event, actions));
}
