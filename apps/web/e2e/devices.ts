// The responsive device matrix (Joel, 0.9: every page and view, from small phones to large
// desktops; T6, 2026-10-24: one device per layout band, no look-alikes). Chromium, emulating
// each device's viewport, touch and pixel density. The site changes layout at 480, 640, 768,
// 1024 and 1280 px and caps its content at 1200 px.
export interface Device {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  scale: number;
}

const touch = (
  name: string,
  width: number,
  height: number,
  scale: number,
): Device => ({ name, width, height, mobile: true, scale });
const desktop = (width: number, height: number): Device => ({
  name: `desktop-${width}`,
  width,
  height,
  mobile: false,
  scale: 1,
});

export const DEVICES: Device[] = [
  // Under 480 px: one column.
  touch('phone-320', 320, 568, 2), // the smallest phones (iPhone SE 1st gen)
  touch('galaxy-z-fold5-folded', 344, 882, 3), // narrow and tall
  touch('iphone-se', 375, 667, 2),
  touch('galaxy-s20-ultra', 412, 915, 3.5),
  // 480–767 px: phones in landscape (the shortest screens) and a small tablet.
  touch('phone-320-landscape', 568, 320, 2),
  touch('small-tablet-portrait', 600, 960, 2),
  touch('iphone-se-landscape', 667, 375, 2),
  // 768–1023 px.
  touch('ipad-mini-portrait', 768, 1024, 2),
  touch('galaxy-z-fold5-unfolded', 882, 1104, 2.5),
  // 1024–1279 px: below the one-row header.
  touch('ipad-pro-12.9-portrait', 1024, 1366, 2),
  touch('ipad-air-landscape', 1180, 820, 2),
  // 1280 px and up: the one-row header, content capped at 1200 px.
  desktop(1280, 800),
  desktop(1920, 1080),
  desktop(2560, 1440),
];

/** Behaviour that doesn't depend on the screen runs on one phone and one desktop. */
export const BEHAVIOUR_DEVICES = ['phone-320', 'desktop-1280'];

/**
 * T8: screenshots are images to look at, not compared, so only 4 sizes take them (one per
 * main layout). The checks (fit, targets, overflow) run on every device.
 */
export const SCREENSHOT_DEVICES = [
  'phone-320',
  'ipad-mini-portrait',
  'desktop-1280',
  'desktop-2560',
];
