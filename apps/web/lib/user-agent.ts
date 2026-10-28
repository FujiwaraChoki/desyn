/** "Chrome on macOS" from a User-Agent string (best effort, for the sessions list). */
export function describeUserAgent(
  ua: string | null | undefined,
): { browser: string; os: string; mobile: boolean } | null {
  if (!ua) return null;
  if (/^Desyn(Desktop|IOS|CLI)/i.test(ua)) {
    const app = /^Desyn(\w+)/i.exec(ua)?.[1]?.toLowerCase();
    return {
      browser:
        app === "ios" ? "Desyn for iPhone" : app === "cli" ? "Desyn CLI" : "Desyn for desktop",
      os: "",
      mobile: app === "ios",
    };
  }
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return { browser, os, mobile: /Mobile|iPhone|Android/.test(ua) };
}
