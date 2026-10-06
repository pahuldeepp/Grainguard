// @vitest-environment jsdom
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { it, expect, vi, afterEach } from "vitest";
import { AssistantDocuments } from "./AssistantDocuments";
import type { AssistantApi } from "./assistant-api";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
const id = "22222222-2222-4222-8222-222222222222";
it("restores only an authorized ready selection and lists progress", async () => {
  sessionStorage.setItem("assistant:selected-pdf:test-user", `${id}:1`);
  const onSelect = vi.fn();
  const onDocuments = vi.fn();
  const api = {
    listDocuments: vi.fn().mockResolvedValue([
      {
        document_id: id,
        document_version: 1,
        filename: "Manual.pdf",
        status: "ready",
      },
    ]),
  } as unknown as AssistantApi;
  render(
    <AssistantDocuments
      api={api}
      sessionId="test-user"
      selected=""
      busy={false}
      onSelect={onSelect}
      onDocuments={onDocuments}
    />,
  );
  await screen.findByText("Manual.pdf");
  expect(onSelect).toHaveBeenCalledWith(`${id}:1`);
  expect(onDocuments).toHaveBeenCalled();
});
it("requires confirmation before deletion and clears selected scope", async () => {
  const onSelect = vi.fn();
  const api = {
    listDocuments: vi.fn().mockResolvedValue([
      {
        document_id: id,
        document_version: 1,
        filename: "Delete.pdf",
        status: "ready",
      },
    ]),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
  } as unknown as AssistantApi;
  render(
    <AssistantDocuments
      api={api}
      sessionId="other-user"
      selected={`${id}:1`}
      busy={false}
      onSelect={onSelect}
      onDocuments={vi.fn()}
    />,
  );
  await screen.findByText("Delete.pdf");
  fireEvent.click(screen.getByText("Delete PDF"));
  expect(api.deleteDocument).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Confirm delete PDF"));
  await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith(id));
  expect(onSelect).toHaveBeenCalledWith("");
});

it("library remains usable when optional storage is unavailable", async () => {
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("disabled", "SecurityError");
  });
  const api = {
    listDocuments: vi.fn().mockResolvedValue([
      {
        document_id: id,
        document_version: 1,
        filename: "Unavailable-storage.pdf",
        status: "ready",
      },
    ]),
  } as unknown as AssistantApi;
  try {
    render(
      <AssistantDocuments
        api={api}
        sessionId="storage-user"
        selected=""
        busy={false}
        onSelect={vi.fn()}
        onDocuments={vi.fn()}
      />,
    );
    await screen.findByText("Unavailable-storage.pdf");
  } finally {
    get.mockRestore();
  }
});

it("upload refresh preserves the hydrated selection", async () => {
  sessionStorage.setItem("assistant:selected-pdf:test-user", `${id}:1`);
  const onSelect = vi.fn();
  const onDocuments = vi.fn();
  const listDocuments = vi.fn().mockResolvedValue([
    {
      document_id: id,
      document_version: 1,
      filename: "Manual.pdf",
      status: "ready",
    },
  ]);
  const api = { listDocuments } as unknown as AssistantApi;
  const props = {
    api,
    sessionId: "test-user",
    selected: `${id}:1`,
    busy: false,
    onSelect,
    onDocuments,
  };
  const view = render(<AssistantDocuments {...props} uploading={false} />);
  await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  view.rerender(<AssistantDocuments {...props} uploading={true} />);
  await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  view.rerender(<AssistantDocuments {...props} uploading={false} />);
  await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(3));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Manual.pdf")).toBeTruthy();
});
