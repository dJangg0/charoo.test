import { test, expect } from "@playwright/test";
test("desktop guest creates an unlisted room, sends a message, and reloads the session", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Same night. New people." }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/charoo-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Shared rooms", exact: true }).click();
  await page.getByRole("button", { name: "Create a shared room" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await expect(page.getByText("Guest · temporary identity")).toBeVisible();
  await page.getByRole("button", { name: "Create a shared room" }).click();
  await page.getByLabel("Room title").fill("Browser test coffee room");
  await page.getByRole("button", { name: "Create & get a link" }).click();
  await expect(
    page.getByRole("heading", { name: "Your room is ready" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Secure room link" }),
  ).toHaveValue(/#room=/);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Hello from a real browser");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .locator(".messages")
      .getByText("Hello from a real browser", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Not confirmed · retry")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Guest · temporary identity")).toBeVisible();
  await page.getByRole("button", { name: "Browser test coffee room" }).click();
  await expect(
    page
      .locator(".messages")
      .getByText("Hello from a real browser", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("mobile navigation, dialog and layout fit the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Same night. New people." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Toggle menu" }).click();
  await page
    .getByRole("button", { name: "Meet a stranger", exact: true })
    .click();
  await page.getByRole("button", { name: "Meet someone", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/charoo-mobile.png", fullPage: true });
});
