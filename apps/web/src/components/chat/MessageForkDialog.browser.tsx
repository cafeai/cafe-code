import { render } from "vitest-browser-react";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { MessageId } from "@cafecode/contracts";
import { MessageForkDialog } from "./MessageForkDialog";

it("explains inclusive native cutoff and shares files without dispatching before confirmation", async () => {
  const onFork = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const id = MessageId.make("selected-middle-message");
  await render(
    <MessageForkDialog
      messageId={id}
      accountLabel="Claude work"
      disabled={false}
      onFork={onFork}
      onClose={onClose}
    />,
  );
  await expect
    .element(page.getByText(/including this message and everything before it/))
    .toBeVisible();
  await expect.element(page.getByText(/workspace files are shared, not rewound/)).toBeVisible();
  expect(onFork).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Create fork", exact: true }).click();
  expect(onFork).toHaveBeenCalledExactlyOnceWith(id);
  expect(onClose).toHaveBeenCalledOnce();
});

it("cancel does nothing, disables busy sources, and never exposes raw failure or retries", async () => {
  const onFork = vi.fn().mockRejectedValue(new Error("private-native-session/path/token"));
  const onClose = vi.fn();
  const props = {
    messageId: MessageId.make("selected"),
    accountLabel: "Claude personal",
    onFork,
    onClose,
  };
  const view = await render(<MessageForkDialog {...props} disabled />);
  await expect
    .element(page.getByRole("button", { name: "Create fork", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(onFork).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  await view.rerender(<MessageForkDialog {...props} disabled={false} />);
  await page.getByRole("button", { name: "Create fork", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "The fork could not be confirmed. Older, very large or compacted histories may be unavailable, and the chat and its background work must be idle. Check the chat and connection, then try again; nothing was resent.",
    );
  await expect
    .element(page.getByRole("button", { name: "Create fork", exact: true }))
    .toBeDisabled();
  expect(onFork).toHaveBeenCalledOnce();
});

it("does not let a previous owner's late completion close a replacement confirmation", async () => {
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const oldClose = vi.fn();
  const newClose = vi.fn();
  const view = await render(
    <MessageForkDialog
      key="old-owner"
      messageId={MessageId.make("old")}
      accountLabel="Old account"
      disabled={false}
      onFork={() => completion}
      onClose={oldClose}
    />,
  );
  await page.getByRole("button", { name: "Create fork", exact: true }).click();
  // The label stays put while pending; the button is disabled instead.
  await expect
    .element(page.getByRole("button", { name: "Create fork", exact: true }))
    .toBeDisabled();
  await view.rerender(
    <MessageForkDialog
      key="new-owner"
      messageId={MessageId.make("new")}
      accountLabel="New account"
      disabled={false}
      onFork={vi.fn()}
      onClose={newClose}
    />,
  );
  resolveCompletion();
  await completion;
  await expect
    .element(page.getByRole("button", { name: "Create fork", exact: true }))
    .toBeEnabled();
  expect(oldClose).not.toHaveBeenCalled();
  expect(newClose).not.toHaveBeenCalled();
});
