/**
 * The banner above the canvas: errors, hints and why a trace stopped early.
 * Its messages can hold buttons (`data-action="run"`) that do what they say.
 */
export class Banner {
  constructor(
    private readonly el: HTMLElement,
    actions: Record<string, () => void>,
  ) {
    el.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action && Object.hasOwn(actions, action)) actions[action]();
    });
  }

  /** Show a message (HTML: escape anything quoted from the program), or hide the banner with null. */
  show(html: string | null): void {
    this.el.hidden = html === null;
    this.el.innerHTML = html ?? "";
  }
}
