import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env.THEME_SCREENSHOT_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const outputDirectory = path.resolve("docs/screenshots");
const viewports = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 1000 },
];
const browserErrors = [];

function parseHex(value) {
  const normalized = value.trim().replace(/^#/, "");
  assert.match(normalized, /^[\da-f]{6}$/i, `Expected a six-digit color token, received ${value}`);
  return [0, 2, 4].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16) / 255);
}

function luminance(color) {
  const [red, green, blue] = parseHex(color).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(8_000);
    page.setDefaultNavigationTimeout(15_000);
    page.on("pageerror", (error) => browserErrors.push(`${viewport.name}px page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`${viewport.name}px console error: ${message.text()}`);
    });

    const response = await page.goto(`${baseUrl}/design-system`, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200, `Gallery should return HTTP 200 at ${viewport.name}px`);
    await page.getByRole("heading", { name: "Componentes del taller" }).waitFor();
    console.log(`${viewport.name}px: gallery rendered.`);

    const layout = await page.evaluate(() => {
      const tokens = getComputedStyle(document.documentElement);
      const read = (name) => tokens.getPropertyValue(name).trim();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        background: read("--app-background"),
        surface: read("--app-surface"),
        text: read("--app-text"),
        muted: read("--app-text-muted"),
        accents: ["--app-blue", "--app-purple", "--app-cyan", "--app-green", "--app-orange", "--app-red"]
          .map(read),
      };
    });

    assert.ok(layout.documentWidth <= layout.viewportWidth, `Horizontal overflow at ${viewport.name}px: ${layout.documentWidth}px`);
    for (const foreground of [layout.text, layout.muted, ...layout.accents]) {
      for (const background of [layout.background, layout.surface]) {
        const ratio = contrastRatio(foreground, background);
        assert.ok(ratio >= 4.5, `Contrast ${foreground} on ${background} is ${ratio.toFixed(2)}:1 (< 4.5:1)`);
      }
    }

    const projectName = page.getByLabel("Nombre del proyecto");
    assert.equal(await projectName.count(), 1, "The project-name field should have an associated visible label");
    await page.screenshot({
      path: path.join(outputDirectory, `theme-${viewport.name}.png`),
      fullPage: true,
      caret: "initial",
      animations: "disabled",
    });

    await page.keyboard.press("Tab");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const focusedText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      if (focusedText.includes("Acción principal")) break;
      await page.keyboard.press("Tab");
    }
    const focusStyle = await page.getByRole("button", { name: "Acción principal" }).evaluate((button) => {
      const style = getComputedStyle(button);
      return { focused: button === document.activeElement, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    assert.ok(focusStyle.focused, `Keyboard navigation should reach the primary button at ${viewport.name}px`);
    assert.notEqual(focusStyle.outlineStyle, "none", `Keyboard focus should be visible at ${viewport.name}px`);
    assert.notEqual(focusStyle.outlineWidth, "0px", `Keyboard focus should have a visible outline at ${viewport.name}px`);

    await page.getByRole("button", { name: "Abrir diálogo de ejemplo" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    await page.screenshot({
      path: path.join(outputDirectory, `theme-dialog-${viewport.name}.png`),
      fullPage: false,
      caret: "initial",
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.close();

    console.log(`${viewport.name}px: no overflow, text contrast >= 4.5:1, keyboard focus visible, dialog opens/closes.`);
  }

  assert.deepEqual(browserErrors, [], `Browser errors were reported:\n${browserErrors.join("\n")}`);
  console.log(`Screenshots saved to ${outputDirectory}`);
} finally {
  await browser.close();
}
