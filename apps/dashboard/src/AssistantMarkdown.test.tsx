// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AssistantMarkdown } from "./AssistantMarkdown";
afterEach(cleanup);
test("renders headings, ordered lists, emphasis and GFM tables", () => {
  render(
    <AssistantMarkdown
      content={
        "## Storage checks\n\n1. **Dry** grain\n2. Check daily\n\n| Item | Action |\n| --- | --- |\n| Bin | Inspect |"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "Storage checks" })).toBeTruthy();
  expect(screen.getByRole("list").tagName).toBe("OL");
  expect(screen.getByText("Dry").tagName).toBe("STRONG");
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Inspect" })).toBeTruthy();
});
test("does not execute HTML, fetch images, or enable unsafe links", () => {
  const { container } = render(
    <AssistantMarkdown
      content={
        "<script>alert(1)</script>\n\n![tracker](https://evil.test/pixel)\n\n[bad](javascript:alert%281%29)\n\n[data](data:text/html,evil)\n\n[good](https://example.com/source)"
      }
    />,
  );
  expect(container.querySelector("script,img,iframe")).toBeNull();
  expect(screen.getByText("bad").closest("a")).toBeNull();
  expect(screen.getByText("data").closest("a")).toBeNull();
  const link = screen.getByRole("link", { name: "good" });
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("keeps table and link focus when the answer rerenders", () => {
  const content =
    "# Storage checks\n\n### Daily checks\n\n[source](https://example.com/source)\n\n| Bin | Action |\n| --- | --- |\n| A | Inspect |";
  const { rerender } = render(<AssistantMarkdown content={content} />);
  const tableRegion = screen.getByRole("region", { name: "Answer table" });
  tableRegion.focus();
  rerender(
    <AssistantMarkdown content={`${content}\n\nUpdated explanation.`} />,
  );
  expect(screen.getByRole("region", { name: "Answer table" })).toBe(
    tableRegion,
  );
  expect(document.activeElement).toBe(tableRegion);
  expect(screen.getByRole("heading", { name: "Storage checks" }).tagName).toBe(
    "H3",
  );
  expect(screen.getByRole("heading", { name: "Daily checks" }).tagName).toBe(
    "H4",
  );
  const link = screen.getByRole("link", { name: "source" });
  link.focus();
  rerender(
    <AssistantMarkdown content={`${content}\n\nAnother explanation.`} />,
  );
  expect(screen.getByRole("link", { name: "source" })).toBe(link);
  expect(document.activeElement).toBe(link);
  expect(link.getAttribute("target")).toBe("_blank");
});
