import type { Page } from "playwright-core";

export interface TypeOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Human-like typing: type character by character with randomised inter-key
 * delays (matches the "paste as human typing" feature commercial browsers ship).
 */
export async function humanType(page: Page, text: string, opts: TypeOptions = {}): Promise<void> {
  const min = opts.minDelayMs ?? 40;
  const max = Math.max(min, opts.maxDelayMs ?? 160);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(min + Math.floor(Math.random() * (max - min)));
  }
}
