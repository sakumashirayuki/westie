import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogFooter, DialogHeader } from "./dialog";

function render(props: { open: boolean; closeDisabled?: boolean }): string {
  return renderToStaticMarkup(
    <Dialog open={props.open} onClose={vi.fn()}>
      <DialogContent closeDisabled={props.closeDisabled ?? false}>
        <DialogHeader eyebrow="TEST" title="标题" description="说明" />
        <DialogFooter>
          <button type="button">确定</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
}

describe("Dialog", () => {
  it("renders an accessible dialog with an icon close button top right", () => {
    const html = render({ open: true });
    expect(html).toContain('role="dialog"');
    expect(html).toContain("标题");
    expect(html).toContain("说明");
    expect(html).toMatch(/<button[^>]*aria-label="关闭"[^>]*>/);
    expect(html).not.toContain(">关闭<");
  });

  it("disables the close button while submitting", () => {
    const html = render({ open: true, closeDisabled: true });
    expect(html).toMatch(/<button[^>]*aria-label="关闭"[^>]*disabled=""/);
  });

  it("renders nothing while closed", () => {
    expect(render({ open: false })).toBe("");
  });
});
