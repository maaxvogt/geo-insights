/**
 * GEO Insights – Fetch-Proxy
 *
 * WARUM ES DEN WORKER GIBT: Eine statische Seite auf GitHub Pages darf fremdes
 * HTML nicht per fetch() laden – die Zielseiten senden kein
 * Access-Control-Allow-Origin. Dieser Worker holt die Seite serverseitig und
 * gibt sie mit CORS-Headern zurück. Die Analyse selbst läuft im Browser.
 *
 * Weil der Endpunkt öffentlich ist, ist er bewusst eng: nur GET, nur http/https
 * auf Standardports, keine internen Adressen (SSRF), nur Text-Antworten,
 * Größenlimit, Timeout, Rate-Limit pro IP.
 */

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 12_000;
const UA =
  "Mozilla/5.0 (compatible; GEO-Insights/1.0; +https://github.com/maaxvogt/geo-insights)";

/** Content-Types, die wir zurückgeben. Alles andere (Bilder, JSON-APIs,
 *  Binärdaten) wäre nur Relay-Traffic ohne Nutzen für die Analyse. */
const TEXT_TYPES = [
  "text/html",
  "text/plain",
  "text/xml",
  "application/xml",
  "application/xhtml",
  "application/rss",
  "text/markdown",
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...extra },
  });

/**
 * Lässt nur öffentlich erreichbare http(s)-URLs durch.
 * Blockt localhost, private Netze, Link-Local (inkl. Cloud-Metadaten 169.254.169.254),
 * .local/.internal und alles ausserhalb der Standardports.
 */
function validateTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: "That is not a valid URL." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "Only http:// and https:// are supported." };
  }
  if (u.port && !["80", "443", ""].includes(u.port)) {
    return { error: "Only the standard ports 80 and 443 are allowed." };
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return { error: "Internal addresses cannot be checked." };
  }

  // IPv4-Literale: private und reservierte Bereiche sperren.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    const blocked =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
    if (blocked) return { error: "Internal addresses cannot be checked." };
  }

  // IPv6-Literale: nur Global Unicast (2000::/3) zulassen.
  if (host.includes(":")) {
    const first = parseInt(host.split(":")[0] || "0", 16);
    if (!(first >= 0x2000 && first <= 0x3fff)) {
      return { error: "Internal addresses cannot be checked." };
    }
  }

  if (!host.includes(".")) {
    return { error: "That domain name looks incomplete." };
  }

  u.hash = "";
  return { url: u };
}

/** Holt eine URL mit Timeout und Größenlimit. Wirft nie – Fehler landen im Ergebnis. */
async function safeFetch(url, { redirect = "follow" } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect,
      signal: ctl.signal,
      headers: {
        // Bewusst KEINE Client-Header weiterreichen: kein Cookie, kein Auth.
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,*;q=0.5",
      },
    });

    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const isText = TEXT_TYPES.some((t) => ctype.includes(t)) || ctype === "";

    let body = "";
    let truncated = false;
    if (isText && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let size = 0;
      const parts = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          parts.push(decoder.decode(value.slice(0, value.byteLength - (size - MAX_BYTES))));
          truncated = true;
          await reader.cancel();
          break;
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      body = parts.join("");
    }

    return {
      ok: true,
      status: res.status,
      finalUrl: res.url || url,
      redirected: res.redirected,
      contentType: ctype,
      isText,
      truncated,
      ms: Date.now() - started,
      headers: {
        "x-robots-tag": res.headers.get("x-robots-tag"),
        "content-type": res.headers.get("content-type"),
        "content-language": res.headers.get("content-language"),
        "cache-control": res.headers.get("cache-control"),
        server: res.headers.get("server"),
        "last-modified": res.headers.get("last-modified"),
      },
      body,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      ms: Date.now() - started,
      error: err.name === "AbortError" ? "timeout" : String(err.message || err),
      body: "",
      headers: {},
    };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "GET only." }, 405);

    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, service: "geo-insights-api" });
    if (url.pathname !== "/api/inspect") return json({ error: "Unknown endpoint." }, 404);

    const target = url.searchParams.get("url");
    if (!target) return json({ error: "Missing the 'url' parameter." }, 400);

    const check = validateTarget(target.trim());
    if (check.error) return json({ error: check.error }, 400);

    // Rate-Limit pro IP. Ohne Binding (z. B. lokal) läuft es einfach durch.
    if (env.INSPECT_LIMITER) {
      const ip = request.headers.get("cf-connecting-ip") || "unbekannt";
      const { success } = await env.INSPECT_LIMITER.limit({ key: ip });
      if (!success) {
        return json(
          { error: "Too many requests. Please wait a minute." },
          429,
          { "Retry-After": "60" },
        );
      }
    }

    const page = await safeFetch(check.url.toString());

    // Nicht aufloesbare Domains wirft die Runtime nicht immer als Fehler: oft
    // kommt eine Platzhalterantwort der Cloudflare-Kante zurueck (HTTP 530,
    // Koerper "error code: 1016"). Die darf nicht als Seite durchgehen, sonst
    // bekommt ein Tippfehler einen Bericht statt einer Fehlermeldung. Ein echtes
    // 5xx der Zielseite bleibt dagegen ein Befund und wird weitergereicht.
    const edgeStub = /^error code: \d+$/i.test((page.body || "").trim());
    if (page.ok && (page.status === 530 || edgeStub)) {
      return json({
        error:
          "The page could not be reached. Check the spelling of the domain, or the server is currently unreachable.",
        detail: `edge stub: HTTP ${page.status} ${(page.body || "").trim().slice(0, 40)}`,
        requestedUrl: check.url.toString(),
      }, 502);
    }

    if (!page.ok) {
      // Die Rohmeldung der Runtime ("internal error; reference = ...") hilft
      // niemandem weiter. Sie bleibt in `detail` für die Fehlersuche stehen.
      return json({
        error:
          page.error === "timeout"
            ? "The page did not respond within 12 seconds."
            : "The page could not be loaded. Check the spelling of the domain, or the server is currently unreachable.",
        detail: page.error,
        requestedUrl: check.url.toString(),
      }, 502);
    }

    if (!page.isText) {
      return json({
        error: `That URL does not return HTML (${page.contentType || "unknown type"}).`,
        requestedUrl: check.url.toString(),
      }, 415);
    }

    // Begleitdateien vom selben Host – für robots/llms/sitemap-Checks.
    const origin = new URL(page.finalUrl).origin;
    const [robots, llms, sitemap] = await Promise.all([
      safeFetch(`${origin}/robots.txt`),
      safeFetch(`${origin}/llms.txt`),
      safeFetch(`${origin}/sitemap.xml`),
    ]);

    const slim = (r) => ({
      status: r.status,
      ok: r.ok && r.status >= 200 && r.status < 300,
      body: r.ok && r.status >= 200 && r.status < 300 ? r.body.slice(0, 200_000) : "",
    });

    return json(
      {
        requestedUrl: check.url.toString(),
        finalUrl: page.finalUrl,
        status: page.status,
        redirected: page.redirected,
        truncated: page.truncated,
        fetchMs: page.ms,
        headers: page.headers,
        html: page.body,
        robots: slim(robots),
        llms: slim(llms),
        sitemap: slim(sitemap),
        fetchedAt: new Date().toISOString(),
      },
      200,
      { "Cache-Control": "public, max-age=60" },
    );
  },
};
