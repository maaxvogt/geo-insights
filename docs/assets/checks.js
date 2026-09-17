/**
 * GEO Insights – Regelwerk.
 *
 * Läuft komplett im Browser. Geprüft wird das ROHE HTML, also genau das, was
 * GPTBot, ClaudeBot & Co. sehen – die führen kein JavaScript aus. Deshalb wird
 * bewusst nicht das gerenderte DOM der Zielseite bewertet.
 */

export const CATEGORIES = [
  {
    id: "access",
    label: "KI-Zugang",
    weight: 30,
    blurb: "Dürfen und können KI-Crawler die Seite überhaupt lesen?",
  },
  {
    id: "structure",
    label: "Struktur",
    weight: 25,
    blurb: "Lässt sich der Inhalt in saubere, zitierbare Abschnitte zerlegen?",
  },
  {
    id: "schema",
    label: "Strukturierte Daten",
    weight: 25,
    blurb: "Sagt die Seite maschinenlesbar, worum es geht und wer dahintersteht?",
  },
  {
    id: "authority",
    label: "Zitierfähigkeit",
    weight: 20,
    blurb: "Gibt es Signale, die eine KI dazu bringen, genau diese Seite zu nennen?",
  },
];

/** KI-Crawler, deren Zugang wir gegen robots.txt prüfen. */
const AI_AGENTS = [
  { ua: "GPTBot", who: "OpenAI (ChatGPT-Index)" },
  { ua: "OAI-SearchBot", who: "ChatGPT Search" },
  { ua: "ChatGPT-User", who: "ChatGPT beim Live-Abruf" },
  { ua: "ClaudeBot", who: "Anthropic (Claude)" },
  { ua: "Claude-User", who: "Claude beim Live-Abruf" },
  { ua: "PerplexityBot", who: "Perplexity" },
  { ua: "Google-Extended", who: "Google Gemini & AI Overviews" },
  { ua: "Applebot-Extended", who: "Apple Intelligence" },
  { ua: "Bingbot", who: "Microsoft Copilot" },
  { ua: "CCBot", who: "Common Crawl (Trainingsbasis vieler Modelle)" },
  { ua: "meta-externalagent", who: "Meta AI" },
];

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                     */
/* ------------------------------------------------------------------ */

function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasUA = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === "user-agent") {
      if (!lastWasUA || !cur) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasUA = true;
    } else if (field === "disallow" || field === "allow") {
      if (!cur) {
        cur = { agents: ["*"], rules: [] };
        groups.push(cur);
      }
      cur.rules.push({ type: field, path: value });
      lastWasUA = false;
    } else {
      lastWasUA = false;
    }
  }
  return groups;
}

function groupFor(groups, ua) {
  const l = ua.toLowerCase();
  return (
    groups.find((g) => g.agents.includes(l)) ||
    groups.find((g) => g.agents.includes("*")) ||
    null
  );
}

// Übersetzt ein robots.txt-Muster in einen regulären Ausdruck.
// "*" steht für beliebig viele Zeichen, "$" am Ende verankert das Pfadende.
// Ein reiner Präfix-Vergleich reicht nicht: das Muster /*/config/ würde dabei
// auf "/" verkürzt und damit die ganze Domain sperren.
function robotsPattern(pattern) {
  let p = pattern;
  let anchorEnd = false;
  if (p.endsWith("$")) {
    anchorEnd = true;
    p = p.slice(0, -1);
  }
  const body = p
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + body + (anchorEnd ? "$" : ""));
}

/** robots.txt-Auswertung: längstes passendes Muster gewinnt, bei Gleichstand "allow". */
function pathAllowed(group, path) {
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (r.path === "") continue; // "Disallow:" ohne Wert erlaubt alles
    let re;
    try {
      re = robotsPattern(r.path);
    } catch {
      continue;
    }
    if (re.test(path)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.type === "allow")) {
        best = { len, type: r.type };
      }
    }
  }
  return best ? best.type === "allow" : true;
}

function flattenJsonLd(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => flattenJsonLd(n, out));
    return;
  }
  if (node["@graph"]) flattenJsonLd(node["@graph"], out);
  if (node["@type"]) out.push(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === "object" && key !== "@graph") flattenJsonLd(v, out);
  }
}

const typeNames = (node) => {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map(String);
};

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/* ------------------------------------------------------------------ */
/* Kontext aus der Serverantwort bauen                                 */
/* ------------------------------------------------------------------ */

export function buildContext(payload) {
  const doc = new DOMParser().parseFromString(payload.html, "text/html");

  const clean = doc.cloneNode(true);
  clean
    .querySelectorAll("script, style, noscript, template, svg, iframe")
    .forEach((n) => n.remove());

  const mainEl =
    clean.querySelector("main") ||
    clean.querySelector("article") ||
    clean.querySelector('[role="main"]') ||
    clean.body;

  const text = (mainEl ? mainEl.textContent : "").replace(/\s+/g, " ").trim();
  const bodyText = (clean.body ? clean.body.textContent : "")
    .replace(/\s+/g, " ")
    .trim();

  // JSON-LD einsammeln, kaputte Blöcke merken statt verschlucken.
  const ldNodes = [];
  let ldBroken = 0;
  const ldScripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
  for (const s of ldScripts) {
    try {
      flattenJsonLd(JSON.parse(s.textContent), ldNodes);
    } catch {
      ldBroken++;
    }
  }
  const ldTypes = new Set(ldNodes.flatMap(typeNames));

  // robots.txt / llms.txt: manche Hosts liefern die 404-Seite mit Status 200.
  const looksLikeHtml = (s) => /^\s*</.test(s);
  const robotsTxt =
    payload.robots.ok && !looksLikeHtml(payload.robots.body) ? payload.robots.body : null;
  const llmsTxt =
    payload.llms.ok && !looksLikeHtml(payload.llms.body) ? payload.llms.body : null;

  const pageUrl = new URL(payload.finalUrl);
  const links = [...doc.querySelectorAll("a[href]")];
  const external = [];
  const internal = [];
  for (const a of links) {
    let href = a.getAttribute("href") || "";
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let abs;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (abs.hostname === pageUrl.hostname) internal.push(abs);
    else external.push(abs);
  }

  const headings = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => ({
    level: Number(h.tagName[1]),
    text: (h.textContent || "").replace(/\s+/g, " ").trim(),
  }));

  const meta = (name) =>
    doc.querySelector(`meta[name="${name}" i]`)?.getAttribute("content")?.trim() || "";
  const prop = (p) =>
    doc.querySelector(`meta[property="${p}" i]`)?.getAttribute("content")?.trim() || "";

  return {
    payload,
    doc,
    pageUrl,
    // Der bereinigte Inhaltsbereich (main/article, sonst body) – ohne Skripte,
    // Styles und noscript. Prüfungen, die "den Text der Seite" meinen, nehmen den.
    mainNode: mainEl,
    text,
    bodyText,
    wordCount: words(text || bodyText),
    headings,
    ldNodes,
    ldTypes,
    ldBroken,
    ldScriptCount: ldScripts.length,
    robotsTxt,
    robotsGroups: robotsTxt ? parseRobots(robotsTxt) : null,
    llmsTxt,
    links: { internal, external },
    meta,
    prop,
  };
}

/* ------------------------------------------------------------------ */
/* Die Prüfungen                                                      */
/* ------------------------------------------------------------------ */

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";
const NA = "na";

export const CHECKS = [
  /* ---------------- KI-Zugang ---------------- */
  {
    id: "http-status",
    cat: "access",
    weight: 3,
    title: "Seite liefert eine saubere Antwort",
    why: "Antwortet die URL nicht mit 200, indexiert kein Crawler den Inhalt – alles Weitere ist dann egal.",
    run: (c) => {
      const s = c.payload.status;
      if (s >= 400) return { status: FAIL, detail: `Die Seite antwortet mit HTTP ${s}.` };
      if (c.payload.redirected)
        return {
          status: WARN,
          detail: `Weiterleitung auf ${c.payload.finalUrl}. Verlinke direkt das Ziel, sonst geht bei jedem Abruf ein Umweg verloren.`,
        };
      return { status: PASS, detail: `HTTP ${s}, direkt ohne Umleitung.` };
    },
  },
  {
    id: "https",
    cat: "access",
    weight: 1,
    title: "HTTPS",
    why: "Unverschlüsselte Seiten werden von mehreren KI-Crawlern übersprungen oder abgewertet.",
    run: (c) =>
      c.pageUrl.protocol === "https:"
        ? { status: PASS, detail: "Die Seite läuft über HTTPS." }
        : { status: FAIL, detail: "Die Seite läuft über unverschlüsseltes HTTP." },
  },
  {
    id: "content-in-html",
    cat: "access",
    weight: 3,
    title: "Inhalt steht im HTML, nicht erst in JavaScript",
    why: "GPTBot, ClaudeBot und PerplexityBot führen kein JavaScript aus. Was erst der Browser nachlädt, existiert für sie nicht.",
    run: (c) => {
      const w = c.wordCount;
      const spaRoot = !!c.doc.querySelector(
        "#root:empty, #app:empty, #__next:empty, [data-reactroot]:empty",
      );
      if (w < 120 || spaRoot)
        return {
          status: FAIL,
          detail: `Im ausgelieferten HTML stehen nur ${w} Wörter Text. Der Inhalt wird offenbar per JavaScript nachgeladen und ist für KI-Crawler unsichtbar.`,
        };
      if (w < 350)
        return {
          status: WARN,
          detail: `Nur ${w} Wörter im rohen HTML. Prüfe, ob Teile des Inhalts erst clientseitig entstehen.`,
        };
      return { status: PASS, detail: `${w} Wörter stehen direkt im HTML.` };
    },
  },
  {
    id: "robots-present",
    cat: "access",
    weight: 1,
    title: "robots.txt vorhanden",
    why: "Ohne robots.txt hast du keine Kontrolle darüber, welcher KI-Crawler was darf.",
    run: (c) =>
      c.robotsTxt
        ? { status: PASS, detail: "robots.txt ist erreichbar." }
        : {
            status: WARN,
            detail:
              "Keine robots.txt gefunden. Crawler dürfen damit zwar alles, du steuerst aber nichts.",
          },
  },
  {
    id: "robots-ai",
    cat: "access",
    weight: 3,
    title: "KI-Crawler sind nicht ausgesperrt",
    why: "Ein einziges 'Disallow: /' für GPTBot reicht, um aus ChatGPT komplett zu verschwinden.",
    run: (c) => {
      if (!c.robotsGroups)
        return {
          status: PASS,
          detail: "Keine robots.txt – damit ist technisch nichts blockiert.",
        };
      const path = c.pageUrl.pathname || "/";
      const blocked = [];
      for (const bot of AI_AGENTS) {
        const g = groupFor(c.robotsGroups, bot.ua);
        if (!pathAllowed(g, path)) blocked.push(bot);
      }
      if (blocked.length === 0)
        return {
          status: PASS,
          detail: `Alle ${AI_AGENTS.length} geprüften KI-Crawler dürfen diese Seite lesen.`,
        };
      return {
        status: FAIL,
        detail: `${blocked.length} KI-Crawler ${blocked.length === 1 ? "ist" : "sind"} für diesen Pfad gesperrt.`,
        evidence: blocked.map((b) => `${b.ua} — ${b.who}`),
      };
    },
  },
  {
    id: "meta-robots",
    cat: "access",
    weight: 3,
    title: "Kein noindex / nosnippet",
    why: "'nosnippet' verbietet jede wörtliche Wiedergabe – die Seite kann dann nicht mehr zitiert werden, auch wenn sie indexiert ist.",
    run: (c) => {
      const vals = [
        c.meta("robots"),
        c.meta("googlebot"),
        c.payload.headers["x-robots-tag"] || "",
      ]
        .join(",")
        .toLowerCase();
      const hits = ["noindex", "nosnippet", "noarchive", "max-snippet:0", "noai"].filter(
        (k) => vals.includes(k),
      );
      if (hits.length)
        return {
          status: FAIL,
          detail: `Die Seite setzt: ${hits.join(", ")}.`,
          evidence: [vals.replace(/^,+|,+$/g, "") || "(leer)"],
        };
      return { status: PASS, detail: "Keine einschränkenden Robots-Direktiven gefunden." };
    },
  },
  {
    id: "llms-txt",
    cat: "access",
    weight: 2,
    title: "llms.txt vorhanden",
    why: "Eine /llms.txt fasst für Sprachmodelle zusammen, was die Seite ist und welche Unterseiten wichtig sind. Noch kein Standard, aber wird zunehmend gelesen.",
    run: (c) =>
      c.llmsTxt && c.llmsTxt.trim().length > 40
        ? { status: PASS, detail: `llms.txt vorhanden (${c.llmsTxt.trim().length} Zeichen).` }
        : {
            status: WARN,
            detail: "Keine /llms.txt gefunden. Günstigster Hebel: eine Markdown-Datei mit Kurzbeschreibung und Links zu den wichtigsten Seiten.",
          },
  },
  {
    id: "sitemap",
    cat: "access",
    weight: 2,
    title: "Sitemap erreichbar",
    why: "Über die Sitemap finden Crawler Unterseiten, die nirgends prominent verlinkt sind.",
    run: (c) => {
      const inRobots = c.robotsTxt && /^\s*sitemap:/im.test(c.robotsTxt);
      if (c.payload.sitemap.ok || inRobots)
        return {
          status: PASS,
          detail: inRobots
            ? "Sitemap ist in der robots.txt eingetragen."
            : "sitemap.xml ist erreichbar.",
        };
      return { status: WARN, detail: "Weder /sitemap.xml erreichbar noch in robots.txt verlinkt." };
    },
  },
  {
    id: "html-lang",
    cat: "access",
    weight: 1,
    title: "Sprache ausgezeichnet",
    why: "Ohne lang-Attribut muss das Modell die Sprache raten – bei kurzen Seiten geht das schief.",
    run: (c) => {
      const lang = c.doc.documentElement.getAttribute("lang");
      return lang
        ? { status: PASS, detail: `<html lang="${lang}">` }
        : { status: WARN, detail: "Das <html>-Element hat kein lang-Attribut." };
    },
  },

  /* ---------------- Struktur ---------------- */
  {
    id: "h1",
    cat: "structure",
    weight: 3,
    title: "Genau eine H1",
    why: "Die H1 ist für ein Modell der Titel des Abschnitts, den es zitiert. Keine oder mehrere machen den Bezug uneindeutig.",
    run: (c) => {
      const n = c.headings.filter((h) => h.level === 1).length;
      if (n === 1)
        return {
          status: PASS,
          detail: `Eine H1: „${c.headings.find((h) => h.level === 1).text.slice(0, 90)}"`,
        };
      if (n === 0) return { status: FAIL, detail: "Die Seite hat keine H1." };
      return { status: WARN, detail: `Die Seite hat ${n} H1-Elemente.` };
    },
  },
  {
    id: "heading-order",
    cat: "structure",
    weight: 2,
    title: "Überschriften ohne Sprünge",
    why: "Modelle leiten aus der Ebenenfolge ab, was zu was gehört. Ein Sprung von H2 auf H4 zerreißt diese Zuordnung.",
    run: (c) => {
      const jumps = [];
      let prev = 0;
      for (const h of c.headings) {
        if (prev && h.level > prev + 1) jumps.push(`H${prev} → H${h.level}: „${h.text.slice(0, 60)}"`);
        prev = h.level;
      }
      if (!c.headings.length) return { status: FAIL, detail: "Keine Überschriften gefunden." };
      return jumps.length
        ? { status: WARN, detail: `${jumps.length} Sprung/Sprünge in der Ebenenfolge.`, evidence: jumps.slice(0, 5) }
        : { status: PASS, detail: `${c.headings.length} Überschriften in sauberer Reihenfolge.` };
    },
  },
  {
    id: "chunking",
    cat: "structure",
    weight: 3,
    title: "Text in zitierbare Abschnitte geteilt",
    why: "KI-Systeme zerlegen Seiten in Passagen. Lange Blöcke ohne Zwischenüberschrift werden als Ganzes zu unspezifisch und fallen raus.",
    run: (c) => {
      const subs = c.headings.filter((h) => h.level >= 2 && h.level <= 4).length;
      if (c.wordCount < 150) return { status: NA, detail: "Zu wenig Text für diese Bewertung." };
      const perSection = Math.round(c.wordCount / (subs + 1));
      if (perSection > 600)
        return { status: FAIL, detail: `Im Schnitt ${perSection} Wörter je Abschnitt (${subs} Zwischenüberschriften). Ziel: unter 300.` };
      if (perSection > 300)
        return { status: WARN, detail: `Im Schnitt ${perSection} Wörter je Abschnitt. Mehr Zwischenüberschriften helfen.` };
      return { status: PASS, detail: `Im Schnitt ${perSection} Wörter je Abschnitt bei ${subs} Zwischenüberschriften.` };
    },
  },
  {
    id: "semantic-html",
    cat: "structure",
    weight: 2,
    title: "Semantische Auszeichnung",
    why: "<main> und <article> trennen den Inhalt von Navigation und Footer. Ohne sie zitiert ein Modell schon mal das Cookie-Banner.",
    run: (c) => {
      const found = ["main", "article", "header", "footer", "nav", "section"].filter((t) =>
        c.doc.querySelector(t),
      );
      const hasMain = found.includes("main") || found.includes("article");
      if (hasMain) return { status: PASS, detail: `Gefunden: <${found.join(">, <")}>` };
      return {
        status: WARN,
        detail: found.length
          ? `Nur <${found.join(">, <")}> – es fehlt <main> oder <article> als klarer Inhaltsbereich.`
          : "Keine semantischen Bereiche, alles steckt in <div>.",
      };
    },
  },
  {
    id: "lists-tables",
    cat: "structure",
    weight: 2,
    title: "Listen und Tabellen",
    why: "Aufzählungen und Tabellen sind das Format, das Sprachmodelle am zuverlässigsten übernehmen und wiedergeben.",
    run: (c) => {
      const lists = c.doc.querySelectorAll("ul li, ol li").length;
      const tables = c.doc.querySelectorAll("table").length;
      if (lists >= 5 || tables >= 1)
        return { status: PASS, detail: `${lists} Listenpunkte, ${tables} Tabelle(n).` };
      if (lists > 0) return { status: WARN, detail: `Nur ${lists} Listenpunkte, keine Tabellen.` };
      return { status: FAIL, detail: "Weder Listen noch Tabellen – reiner Fließtext." };
    },
  },
  {
    id: "content-length",
    cat: "structure",
    weight: 2,
    title: "Genug Inhalt",
    why: "Unter ~300 Wörtern fehlt der Kontext, aus dem ein Modell eine belastbare Antwort ziehen kann.",
    run: (c) => {
      if (c.wordCount >= 300) return { status: PASS, detail: `${c.wordCount} Wörter Inhalt.` };
      if (c.wordCount >= 150) return { status: WARN, detail: `Nur ${c.wordCount} Wörter Inhalt.` };
      return { status: FAIL, detail: `Nur ${c.wordCount} Wörter Inhalt.` };
    },
  },
  {
    id: "question-headings",
    cat: "structure",
    weight: 2,
    title: "Überschriften im Frageformat",
    why: "Nutzer stellen Fragen. Eine Überschrift, die die Frage wörtlich enthält, matcht direkt auf den Prompt.",
    run: (c) => {
      const re = /^(was|wie|warum|wieso|wann|wo|welche[rsn]?|wer|kann|ist|sind|gibt|darf|muss|what|how|why|when|where|who|which|can|is|are|does|do)\b/i;
      const qs = c.headings.filter((h) => h.text.endsWith("?") || re.test(h.text));
      if (qs.length >= 2)
        return { status: PASS, detail: `${qs.length} Überschriften im Frageformat.`, evidence: qs.slice(0, 4).map((h) => h.text.slice(0, 80)) };
      if (qs.length === 1) return { status: WARN, detail: "Nur eine Überschrift im Frageformat." };
      return { status: WARN, detail: "Keine Überschrift formuliert eine Nutzerfrage." };
    },
  },
  {
    id: "text-ratio",
    cat: "structure",
    weight: 1,
    title: "Verhältnis Text zu Markup",
    why: "Sehr viel Markup um wenig Text herum ist ein Hinweis auf einen Baukasten-Export, in dem der Inhalt untergeht.",
    run: (c) => {
      const ratio = c.bodyText.length / Math.max(1, c.payload.html.length);
      const pct = (ratio * 100).toFixed(1);
      if (ratio >= 0.08) return { status: PASS, detail: `${pct} % der Seite sind Text.` };
      if (ratio >= 0.03) return { status: WARN, detail: `Nur ${pct} % der Seite sind Text.` };
      return { status: FAIL, detail: `Nur ${pct} % der Seite sind Text, der Rest ist Markup.` };
    },
  },

  /* ---------------- Strukturierte Daten ---------------- */
  {
    id: "jsonld",
    cat: "schema",
    weight: 3,
    title: "JSON-LD vorhanden",
    why: "Strukturierte Daten sind die einzige Stelle, an der du einer Maschine unmissverständlich sagst, was die Seite ist.",
    run: (c) => {
      if (c.ldBroken && !c.ldNodes.length)
        return { status: FAIL, detail: `${c.ldBroken} JSON-LD-Block/Blöcke vorhanden, aber nicht parsebar.` };
      if (!c.ldNodes.length)
        return { status: FAIL, detail: "Kein JSON-LD auf der Seite." };
      const t = [...c.ldTypes];
      return {
        status: c.ldBroken ? WARN : PASS,
        detail: c.ldBroken
          ? `${c.ldScriptCount} Blöcke, davon ${c.ldBroken} fehlerhaft.`
          : `${c.ldScriptCount} JSON-LD-Block/Blöcke mit ${t.length} Typ(en).`,
        evidence: t.slice(0, 12),
      };
    },
  },
  {
    id: "schema-entity",
    cat: "schema",
    weight: 3,
    title: "Absender ist ausgezeichnet",
    why: "Organization oder LocalBusiness verknüpft die Seite mit einer realen Entität. Ohne das bleibt die Quelle für ein Modell anonym.",
    run: (c) => {
      const hit = ["Organization", "LocalBusiness", "Corporation", "Person", "WebSite", "Store", "Brand"].filter(
        (t) => [...c.ldTypes].some((x) => x === t || x.endsWith(t)),
      );
      return hit.length
        ? { status: PASS, detail: `Ausgezeichnet als: ${hit.join(", ")}.` }
        : { status: FAIL, detail: "Keine Organization/Person/WebSite in den strukturierten Daten." };
    },
  },
  {
    id: "schema-pagetype",
    cat: "schema",
    weight: 2,
    title: "Seitentyp ist ausgezeichnet",
    why: "Article, Product oder FAQPage sagen dem Modell, welche Art Antwort es hier holen kann.",
    run: (c) => {
      const kinds = ["Article", "BlogPosting", "NewsArticle", "Product", "FAQPage", "HowTo", "Service", "Event", "Recipe", "WebPage", "CollectionPage", "AboutPage", "ContactPage", "ItemList"];
      const hit = kinds.filter((t) => c.ldTypes.has(t));
      return hit.length
        ? { status: PASS, detail: `Seitentyp: ${hit.join(", ")}.` }
        : { status: WARN, detail: "Kein inhaltlicher Seitentyp ausgezeichnet." };
    },
  },
  {
    id: "schema-breadcrumb",
    cat: "schema",
    weight: 1,
    title: "Breadcrumb",
    why: "Die Breadcrumb zeigt, wo die Seite im Gesamtangebot steht – Kontext, den ein Modell sonst raten muss.",
    run: (c) =>
      c.ldTypes.has("BreadcrumbList")
        ? { status: PASS, detail: "BreadcrumbList vorhanden." }
        : { status: WARN, detail: "Keine BreadcrumbList ausgezeichnet." },
  },
  {
    id: "title",
    cat: "schema",
    weight: 3,
    title: "Title-Tag",
    why: "Der Title ist meist die Zeile, mit der eine KI die Quelle benennt.",
    run: (c) => {
      const t = (c.doc.querySelector("title")?.textContent || "").trim();
      if (!t) return { status: FAIL, detail: "Kein Title-Tag." };
      if (t.length < 15) return { status: WARN, detail: `Title ist mit ${t.length} Zeichen sehr kurz: „${t}"` };
      if (t.length > 70) return { status: WARN, detail: `Title ist mit ${t.length} Zeichen sehr lang.`, evidence: [t] };
      return { status: PASS, detail: `„${t}" (${t.length} Zeichen)` };
    },
  },
  {
    id: "description",
    cat: "schema",
    weight: 3,
    title: "Meta-Description",
    why: "Die Description ist oft der erste Textblock, den ein Modell zur Seite überhaupt verarbeitet.",
    run: (c) => {
      const d = c.meta("description") || c.prop("og:description");
      if (!d) return { status: FAIL, detail: "Keine Meta-Description gesetzt." };
      if (d.length < 50) return { status: WARN, detail: `Nur ${d.length} Zeichen: „${d}"` };
      if (d.length > 175) return { status: WARN, detail: `${d.length} Zeichen – wird abgeschnitten.`, evidence: [d] };
      return { status: PASS, detail: `${d.length} Zeichen.`, evidence: [d] };
    },
  },
  {
    id: "canonical",
    cat: "schema",
    weight: 2,
    title: "Canonical-URL",
    why: "Ohne Canonical verteilt sich die Autorität auf Varianten derselben Seite – zitiert wird dann vielleicht die falsche.",
    run: (c) => {
      const href = c.doc.querySelector('link[rel="canonical" i]')?.getAttribute("href");
      if (!href) return { status: WARN, detail: "Keine Canonical-URL gesetzt." };
      try {
        const abs = new URL(href, c.pageUrl);
        return { status: PASS, detail: abs.toString() };
      } catch {
        return { status: WARN, detail: `Canonical ist keine gültige URL: „${href}"` };
      }
    },
  },
  {
    id: "open-graph",
    cat: "schema",
    weight: 1,
    title: "Open-Graph-Daten",
    why: "OG-Tags sind ein zweiter, redundanter Kanal für Titel und Beschreibung – hilfreich, wenn das HTML unsauber ist.",
    run: (c) => {
      const have = ["og:title", "og:description", "og:image", "og:type"].filter((p) => c.prop(p));
      if (have.length >= 3) return { status: PASS, detail: `Gesetzt: ${have.join(", ")}.` };
      if (have.length) return { status: WARN, detail: `Nur ${have.join(", ")} gesetzt.` };
      return { status: WARN, detail: "Keine Open-Graph-Tags." };
    },
  },

  /* ---------------- Zitierfähigkeit ---------------- */
  {
    id: "author",
    cat: "authority",
    weight: 2,
    title: "Urheber erkennbar",
    why: "Modelle bevorzugen Quellen mit benanntem Absender. Anonymer Text wird seltener zitiert.",
    run: (c) => {
      const fromLd = c.ldNodes.find((n) => n.author || n.creator || n.publisher);
      const metaAuthor = c.meta("author");
      const relAuthor = c.doc.querySelector('[rel="author"], [itemprop="author"], .author, .byline');
      if (fromLd) {
        const a = fromLd.author || fromLd.creator || fromLd.publisher;
        const name = typeof a === "string" ? a : a?.name || "(ohne Namen)";
        return { status: PASS, detail: `Aus strukturierten Daten: ${name}` };
      }
      if (metaAuthor) return { status: PASS, detail: `meta[author]: ${metaAuthor}` };
      if (relAuthor) return { status: WARN, detail: "Autor nur im Markup, nicht in strukturierten Daten." };
      return { status: FAIL, detail: "Kein Autor und kein Herausgeber erkennbar." };
    },
  },
  {
    id: "dates",
    cat: "authority",
    weight: 2,
    title: "Datum vorhanden und aktuell",
    why: "Ohne Datum kann ein Modell die Aktualität nicht einschätzen und greift im Zweifel zur datierten Konkurrenz.",
    run: (c) => {
      const cand = [];
      for (const n of c.ldNodes) {
        for (const k of ["dateModified", "datePublished", "uploadDate"]) if (n[k]) cand.push(n[k]);
      }
      const t = c.doc.querySelector("time[datetime]")?.getAttribute("datetime");
      if (t) cand.push(t);
      const pub = c.prop("article:modified_time") || c.prop("article:published_time");
      if (pub) cand.push(pub);

      if (!cand.length) return { status: WARN, detail: "Kein maschinenlesbares Datum auf der Seite." };
      const newest = cand
        .map((d) => new Date(d))
        .filter((d) => !isNaN(d))
        .sort((a, b) => b - a)[0];
      if (!newest) return { status: WARN, detail: `Datum vorhanden, aber nicht lesbar: ${cand[0]}` };
      const months = (Date.now() - newest) / (1000 * 60 * 60 * 24 * 30.4);
      const shown = newest.toISOString().slice(0, 10);
      if (months > 24) return { status: WARN, detail: `Letzte Änderung ${shown} – über zwei Jahre her.` };
      return { status: PASS, detail: `Letzte Änderung: ${shown}` };
    },
  },
  {
    id: "citations",
    cat: "authority",
    weight: 2,
    title: "Belege nach außen",
    why: "Seiten, die selbst Quellen nennen, werden von KI-Systemen als verlässlicher eingestuft.",
    run: (c) => {
      const social = /(facebook|instagram|twitter|x\.com|linkedin|youtube|tiktok|pinterest|whatsapp)\./i;
      const refs = c.links.external.filter((u) => !social.test(u.hostname));
      const hosts = [...new Set(refs.map((u) => u.hostname))];
      if (hosts.length >= 3) return { status: PASS, detail: `Verweise auf ${hosts.length} externe Quellen.`, evidence: hosts.slice(0, 6) };
      if (hosts.length >= 1) return { status: WARN, detail: `Nur ${hosts.length} externe Quelle(n).`, evidence: hosts };
      return { status: WARN, detail: "Keine externen Belege verlinkt." };
    },
  },
  {
    id: "specifics",
    cat: "authority",
    weight: 2,
    title: "Konkrete Zahlen im Text",
    why: "Zahlen, Maße und Preise sind das, was eine KI wörtlich übernimmt. Reine Werbesprache liefert nichts zum Zitieren.",
    run: (c) => {
      const hits = c.text.match(/\b\d[\d.,]*\s?(%|mm|cm|m²|m2|m\b|kg|db|dB|€|eur|euro|std|stunden|minuten|jahre|tage|watt|w\b)/gi) || [];
      if (c.wordCount < 100) return { status: NA, detail: "Zu wenig Text für diese Bewertung." };
      if (hits.length >= 5) return { status: PASS, detail: `${hits.length} konkrete Angaben im Text.`, evidence: [...new Set(hits)].slice(0, 8) };
      if (hits.length >= 2) return { status: WARN, detail: `Nur ${hits.length} konkrete Angaben im Text.` };
      return { status: WARN, detail: "Kaum konkrete Zahlen oder Maße – wenig, was sich zitieren lässt." };
    },
  },
  {
    id: "direct-answer",
    cat: "authority",
    weight: 3,
    title: "Direkte Antwort am Anfang",
    why: "Der erste Absatz nach der H1 ist die Passage, die am häufigsten als Antwort herausgezogen wird. Er sollte die Kernaussage in zwei bis drei Sätzen enthalten.",
    run: (c) => {
      const scope = c.mainNode || c.doc;
      const ps = [...scope.querySelectorAll("p")]
        .map((p) => (p.textContent || "").replace(/\s+/g, " ").trim())
        .filter((t) => words(t) >= 8);
      if (!ps.length) return { status: FAIL, detail: "Kein zusammenhängender Absatz gefunden – die Seite besteht aus Fragmenten." };
      const first = ps[0];
      const w = words(first);
      if (w > 120) return { status: WARN, detail: `Der erste Absatz hat ${w} Wörter – zu lang für eine direkte Antwort.`, evidence: [first.slice(0, 200) + "…"] };
      if (w < 15) return { status: WARN, detail: `Der erste Absatz hat nur ${w} Wörter.`, evidence: [first] };
      return { status: PASS, detail: `Erster Absatz: ${w} Wörter.`, evidence: [first.slice(0, 220)] };
    },
  },
  {
    id: "faq",
    cat: "authority",
    weight: 2,
    title: "Frage-Antwort-Block",
    why: "Ein FAQ-Abschnitt liefert fertige Antwortpaare – das Format, das KI-Systeme am direktesten übernehmen.",
    run: (c) => {
      if (c.ldTypes.has("FAQPage") || c.ldTypes.has("Question"))
        return { status: PASS, detail: "FAQ ist als strukturierte Daten ausgezeichnet." };
      const details = c.doc.querySelectorAll("details summary").length;
      const qHeads = c.headings.filter((h) => h.text.endsWith("?")).length;
      if (details >= 3 || qHeads >= 3)
        return { status: WARN, detail: `FAQ-Struktur im Markup erkennbar (${details || qHeads} Einträge), aber nicht als FAQPage ausgezeichnet.` };
      return { status: WARN, detail: "Kein Frage-Antwort-Bereich auf der Seite." };
    },
  },
  {
    id: "imprint",
    cat: "authority",
    weight: 1,
    title: "Impressum und Kontakt verlinkt",
    why: "Erreichbarkeit und Rechtsangaben sind klassische Vertrauenssignale, die in die Bewertung einer Quelle einfließen.",
    run: (c) => {
      const re = /(impressum|kontakt|contact|about|ueber-uns|über-uns|legal|datenschutz|privacy)/i;
      const hit = c.links.internal.filter((u) => re.test(u.pathname));
      const paths = [...new Set(hit.map((u) => u.pathname))];
      return paths.length
        ? { status: PASS, detail: `Verlinkt: ${paths.slice(0, 4).join(", ")}` }
        : { status: WARN, detail: "Weder Impressum noch Kontakt oder Über-uns verlinkt." };
    },
  },
  {
    id: "image-alt",
    cat: "authority",
    weight: 1,
    title: "Alt-Texte an Bildern",
    why: "Alt-Texte sind für ein Sprachmodell der einzige Zugang zum Bildinhalt.",
    run: (c) => {
      const imgs = [...c.doc.querySelectorAll("img")];
      if (!imgs.length) return { status: NA, detail: "Keine Bilder auf der Seite." };
      const withAlt = imgs.filter((i) => (i.getAttribute("alt") || "").trim().length > 0).length;
      const pct = Math.round((withAlt / imgs.length) * 100);
      if (pct >= 90) return { status: PASS, detail: `${withAlt} von ${imgs.length} Bildern haben einen Alt-Text (${pct} %).` };
      if (pct >= 50) return { status: WARN, detail: `Nur ${withAlt} von ${imgs.length} Bildern haben einen Alt-Text (${pct} %).` };
      return { status: FAIL, detail: `Nur ${withAlt} von ${imgs.length} Bildern haben einen Alt-Text (${pct} %).` };
    },
  },
  {
    id: "internal-links",
    cat: "authority",
    weight: 1,
    title: "Interne Verlinkung",
    why: "Interne Links zeigen dem Crawler den Rest des Angebots und bauen thematischen Zusammenhang auf.",
    run: (c) => {
      const n = new Set(c.links.internal.map((u) => u.pathname)).size;
      if (n >= 5) return { status: PASS, detail: `${n} verschiedene interne Ziele verlinkt.` };
      if (n >= 2) return { status: WARN, detail: `Nur ${n} interne Ziele verlinkt.` };
      return { status: FAIL, detail: "Praktisch keine interne Verlinkung." };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Auswertung                                                          */
/* ------------------------------------------------------------------ */

const VALUE = { pass: 1, warn: 0.5, fail: 0 };

export function analyze(payload) {
  const ctx = buildContext(payload);

  const results = CHECKS.map((def) => {
    let r;
    try {
      r = def.run(ctx);
    } catch (err) {
      r = { status: NA, detail: `Prüfung nicht möglich (${err.message}).` };
    }
    return { ...def, ...r };
  });

  const categories = CATEGORIES.map((cat) => {
    const own = results.filter((r) => r.cat === cat.id);
    const scored = own.filter((r) => r.status !== NA);
    const max = scored.reduce((s, r) => s + r.weight, 0);
    const got = scored.reduce((s, r) => s + r.weight * VALUE[r.status], 0);
    return {
      ...cat,
      score: max ? Math.round((got / max) * 100) : 0,
      checks: own,
      counts: {
        fail: own.filter((r) => r.status === FAIL).length,
        warn: own.filter((r) => r.status === WARN).length,
        pass: own.filter((r) => r.status === PASS).length,
        na: own.filter((r) => r.status === NA).length,
      },
    };
  });

  const totalW = categories.reduce((s, c) => s + c.weight, 0);
  const overall = Math.round(
    categories.reduce((s, c) => s + c.score * c.weight, 0) / totalW,
  );

  return { ctx, results, categories, overall };
}

export const scoreClass = (n) => (n >= 90 ? "pass" : n >= 50 ? "average" : "fail");
