// The responsive device matrix (Joel, 0.9: every page and view, from small phones to large
// desktops). Chromium only, emulating each device's viewport, touch and pixel density.
export interface Device {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  scale: number;
}

const phone = (
  name: string,
  width: number,
  height: number,
  scale = 3,
): Device => ({
  name,
  width,
  height,
  mobile: true,
  scale,
});
const tablet = (name: string, width: number, height: number): Device[] => [
  { name: `${name}-portrait`, width, height, mobile: true, scale: 2 },
  {
    name: `${name}-landscape`,
    width: height,
    height: width,
    mobile: true,
    scale: 2,
  },
];
const desktop = (width: number, height: number): Device => ({
  name: `desktop-${width}`,
  width,
  height,
  mobile: false,
  scale: 1,
});

export const DEVICES: Device[] = [
  phone('phone-320', 320, 568, 2), // the smallest phones (iPhone SE 1st gen)
  phone('iphone-se', 375, 667, 2),
  phone('galaxy-z-fold5-folded', 344, 882),
  phone('galaxy-s20-ultra', 412, 915, 3.5),
  phone('iphone-14-pro-max', 430, 932),
  {
    name: 'galaxy-z-fold5-unfolded',
    width: 882,
    height: 1104,
    mobile: true,
    scale: 2.5,
  },
  ...tablet('ipad-mini', 768, 1024),
  ...tablet('ipad-air', 820, 1180),
  ...tablet('ipad-pro-12.9', 1024, 1366),
  desktop(1280, 800),
  desktop(1440, 900),
  desktop(1920, 1080),
  desktop(2560, 1440),
];
