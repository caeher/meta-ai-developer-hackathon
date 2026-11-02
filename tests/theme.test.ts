import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokenSource = readFileSync(resolve(process.cwd(), "apps/web/styles/tokens.css"), "utf8");
const radixSource = readFileSync(resolve(process.cwd(), "apps/web/styles/radix.css"), "utf8");

function colorToken(name: string): string {
  const match = tokenSource.match(new RegExp(`--app-${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match) throw new Error(`Falta el token --app-${name}`);
  return match[1]!.slice(1);
}

function relativeLuminance(hex: string): number {
  const channels = hex.match(/.{2}/g);
  if (!channels || channels.length !== 3) throw new Error(`Color hexadecimal inválido: ${hex}`);
  const [redHex, greenHex, blueHex] = channels;
  const luminanceChannel = (channel: string) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const red = luminanceChannel(redHex!);
  const green = luminanceChannel(greenHex!);
  const blue = luminanceChannel(blueHex!);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("tema Tokyo Night", () => {
  it("conserva la paleta acordada en tokens semánticos", () => {
    expect(colorToken("background")).toBe("1a1b26");
    expect(colorToken("surface")).toBe("24283b");
    expect(colorToken("text")).toBe("c0caf5");
    expect(colorToken("blue")).toBe("7aa2f7");
    expect(colorToken("purple")).toBe("bb9af7");
    expect(colorToken("cyan")).toBe("7dcfff");
    expect(colorToken("green")).toBe("9ece6a");
    expect(colorToken("orange")).toBe("ff9e64");
    expect(colorToken("red")).toBe("f7768e");
  });

  it("mantiene texto AA y acentos legibles sobre fondo y superficie", () => {
    const background = colorToken("background");
    const surface = colorToken("surface");
    const textColors = ["text", "text-muted", "blue", "purple", "cyan", "green", "orange", "red"];

    for (const name of textColors) {
      const foreground = colorToken(name);
      expect(contrastRatio(foreground, background), `${name} sobre fondo`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(foreground, surface), `${name} sobre superficie`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("da contraste suficiente a botones sólidos y al indicador de foco", () => {
    const background = colorToken("background");
    const focus = colorToken("focus");
    for (const name of ["blue", "purple", "cyan", "green", "orange", "red"]) {
      expect(contrastRatio(background, colorToken(name)), `texto en botón ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(focus, background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(focus, colorToken("surface"))).toBeGreaterThanOrEqual(3);
  });

  it("mapea escalas sólidas, alpha, contraste y foco de Radix", () => {
    for (const scale of ["gray", "blue", "purple", "cyan", "green", "orange", "red"]) {
      for (let step = 1; step <= 12; step += 1) {
        expect(radixSource).toMatch(new RegExp(`--${scale}-${step}:\\s*[^;]+;`));
        expect(radixSource).toMatch(new RegExp(`--${scale}-a${step}:\\s*[^;]+;`));
      }
    }
    expect(radixSource).toContain("--blue-contrast: var(--app-background)");
    expect(radixSource).toContain("--accent-contrast: var(--blue-contrast)");
    expect(radixSource).toContain("--focus-8: var(--app-focus)");
    expect(radixSource).toContain("--color-panel-solid: var(--app-surface)");
  });
});
