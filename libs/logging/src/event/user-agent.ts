/**
 * `client.browser / os / device` (LG-2, plain): the browser's user agent read roughly, so stats
 * can group without parsing it each time. Rough on purpose: the plain `client.user_agent` beside
 * it is the record; these only need to be right for common browsers.
 */
export interface ClientKind {
  browser?: string;
  os?: string;
  device: 'mobile' | 'tablet' | 'desktop' | 'bot' | 'unknown';
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/\bOPR\/(\d+)/, 'Opera'],
  [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/\bFirefox\/(\d+)/, 'Firefox'],
  [/\bFxiOS\/(\d+)/, 'Firefox'],
  [/\bCriOS\/(\d+)/, 'Chrome'],
  [/\bChrome\/(\d+)/, 'Chrome'],
  [/\bVersion\/(\d+)[\d.]* .*Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/Windows NT 10\.0/, () => 'Windows 10'],
  [/Windows NT (\d+\.\d+)/, (m) => `Windows NT ${m[1]}`],
  [/Android (\d+)/, (m) => `Android ${m[1]}`],
  [/(?:iPhone|iPad|iPod).* OS (\d+)/, (m) => `iOS ${m[1]}`],
  [/CrOS/, () => 'ChromeOS'],
  [/Mac OS X (\d+)[_.](\d+)/, (m) => `macOS ${m[1]}.${m[2]}`],
  [/Linux/, () => 'Linux'],
];

const BOT =
  /bot|crawl|spider|slurp|curl|wget|python-requests|httpclient|headless/i;

export function clientKind(userAgent: string | undefined): ClientKind {
  if (!userAgent) return { device: 'unknown' };
  const kind: ClientKind = { device: 'desktop' };
  for (const [pattern, name] of BROWSERS) {
    const m = pattern.exec(userAgent);
    if (m) {
      kind.browser = `${name} ${m[1]}`;
      break;
    }
  }
  for (const [pattern, name] of SYSTEMS) {
    const m = pattern.exec(userAgent);
    if (m) {
      kind.os = name(m);
      break;
    }
  }
  if (BOT.test(userAgent)) kind.device = 'bot';
  else if (/iPad|Tablet|Android(?!.*Mobile)/.test(userAgent))
    kind.device = 'tablet';
  else if (/Mobi|iPhone|iPod/.test(userAgent)) kind.device = 'mobile';
  return kind;
}
