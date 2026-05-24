import { expect, test } from "@playwright/test";

test("scaffold routes are explicit and do not allow fake recording success", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "我的录制" })).toBeVisible();

  await page.getByRole("link", { name: "新建录制" }).click();
  await expect(page.getByText(/CodeEditor scaffold/)).toBeVisible();
  await expect(page.getByText(/RecorderControls scaffold/)).toBeVisible();
  await expect(page.getByRole("button", { name: "开始录制" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "运行代码" })).toBeDisabled();

  await page.getByRole("button", { name: /Dark|Light/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
});

test("missing replay id shows an explicit load error", async ({ page }) => {
  await page.goto("/replay/missing-recording", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/加载失败/)).toBeVisible();
  await expect(page.getByText(/incomplete-package/)).toBeVisible();
});
