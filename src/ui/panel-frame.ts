import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Thin box frame drawn around a child component, mirroring show-diff's
 * `BorderFrame`: a top/bottom rule and side rails. The child renders at
 * `width - 2` and each resulting line is re-padded to the full width, so the
 * framed output never exceeds `width`. Falls back to the bare child when the
 * available width is too narrow to frame.
 */
export class PanelFrame {
  constructor(
    private readonly child: {
      render(width: number): string[];
      invalidate(): void;
    },
    private readonly borderColor: (text: string) => string,
  ) {}

  invalidate(): void {
    this.child.invalidate();
  }

  render(width: number): string[] {
    if (width <= 4) {
      return this.child.render(width);
    }
    const innerWidth = Math.max(1, width - 2);
    const rule = "─".repeat(innerWidth);
    const top = this.borderColor(`┌${rule}┐`);
    const bottom = this.borderColor(`└${rule}┘`);
    const body = this.child.render(innerWidth).map((line) => {
      const safe = truncateToWidth(line, innerWidth, "", true);
      return this.borderColor("│") + safe + this.borderColor("│");
    });
    return [top, ...body, bottom];
  }
}
