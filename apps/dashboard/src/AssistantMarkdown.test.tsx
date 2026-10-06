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
