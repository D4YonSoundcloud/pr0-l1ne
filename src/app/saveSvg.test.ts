// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { addSaveSvg, svgFileName } from "./saveSvg";

describe("svgFileName", () => {
  it("names the file after the program, the window and the step (counted from 1)", () => {
    expect(svgFileName("Bubble sort", "memory", 11)).toBe("bubble-sort-memory-step-12.svg");
    expect(svgFileName("  Dijkstra's shortest paths (weighted)!", "loop", 0)).toBe(
      "dijkstra-s-shortest-paths-weighted-loop-history-step-1.svg",
    );
    expect(svgFileName("Café für alle", "memory", 2)).toBe("cafe-fur-alle-memory-step-3.svg");
    expect(svgFileName(null, "memory", 0)).toBe("pr0l1ne-memory-step-1.svg");
    expect(svgFileName("!!!", "loop", 4)).toBe("pr0l1ne-loop-history-step-5.svg");
    expect(svgFileName("x".repeat(100), "memory", 0)).toBe(`${"x".repeat(60)}-memory-step-1.svg`);
  });
});

describe("addSaveSvg", () => {
  it("adds a button that saves the drawing on screen, under the name at that moment", () => {
    let onClick: () => void = () => {};
    const button = document.createElement("button");
    let drawing: string | null = "<svg/>";
    const renderer = {
      addControl: vi.fn((_label: string, _title: string, click: () => void) => {
        onClick = click;
        return button;
      }),
      toSVG: () => drawing,
    };
    const save = vi.fn();
    let step = 1;
    expect(addSaveSvg(renderer, () => `step-${step}.svg`, save)).toBe(button);
    expect(renderer.addControl.mock.calls[0][0]).toBe("Save SVG");
    step = 4;
    onClick();
    expect(save).toHaveBeenCalledWith("step-4.svg", "<svg/>");
    drawing = null; // nothing drawn: nothing to save
    onClick();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
