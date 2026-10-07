export interface DetectionTarget {
  id: string;
  url: string;
  /** Keywords in page text that usually indicate a block/challenge. */
  blockKeywords?: string[];
  /** ms to wait after load before capturing. */
  settleMs?: number;
}

/**
 * Known public fingerprint self-check pages. They don't expose a stable API, so
 * the runner captures a screenshot + text and applies a block heuristic. Review
 * the screenshots in data/reports for the ground truth.
 */
export const TARGETS: DetectionTarget[] = [
  {
    id: "sannysoft",
    url: "https://bot.sannysoft.com/",
    settleMs: 1500,
  },
  {
    id: "rebrowser-bot-detector",
    url: "https://bot-detector.rebrowser.net/",
    settleMs: 2500,
  },
  {
    id: "creepjs",
    url: "https://abrahamjuliot.github.io/creepjs/",
    settleMs: 3500,
  },
  {
    id: "pixelscan",
    url: "https://pixelscan.net/",
    blockKeywords: ["captcha", "are you a robot"],
    settleMs: 4000,
  },
  {
    id: "browserleaks-canvas",
    url: "https://browserleaks.com/canvas",
    settleMs: 1500,
  },
  {
    id: "browserleaks-webrtc",
    url: "https://browserleaks.com/webrtc",
    settleMs: 2000,
  },
];
