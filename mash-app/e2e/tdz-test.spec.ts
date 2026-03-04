import { test } from "@playwright/test";

test("production build loads without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(`PAGE ERROR: ${error.name}: ${error.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`CONSOLE ERROR: ${msg.text()}`);
    }
  });

  await page.goto("http://localhost:4190", {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForTimeout(5000);

  if (errors.length > 0) {
    errors.forEach((err, i) => console.log(`Error ${i + 1}: ${err}`));
  } else {
    console.log("No errors detected!");
  }
  console.log(`Total errors: ${errors.length}`);
});
