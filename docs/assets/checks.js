/**
 * GEO Insights – Regelwerk.
 *
 * Laeuft komplett im Browser. Geprueft wird das ROHE HTML, also genau das, was
 * GPTBot, ClaudeBot & Co. sehen – die fuehren kein JavaScript aus. Deshalb wird
 * bewusst nicht das gerenderte DOM der Zielseite bewertet.
 *
 * Die Oberflaeche ist englisch, die Erkennungsmuster bleiben mehrsprachig:
 * geprueft werden fremde Seiten, und die sind oft deutsch.
 */

export const CATEGORIES = [
  {
    id: "access",
    label: "AI access",
    weight: 30,
    blurb: "Are AI crawlers allowed and able to read this page at all?",
  },
  {
    id: "structure",
    label: "Structure",
    weight: 25,
    blurb: "Can the content be split into clean, quotable sections?",
  },
  {
    id: "schema",
    label: "Structured data",
    weight: 25,
    blurb: "Does the page state machine-readably what it is and who stands behind it?",
  },
  {
    id: "authority",
    label: "Citability",
    weight: 20,
    blurb: "Are there signals that make an AI name this page in particular?",
  },
];

/** KI-Crawler, deren Zugang wir gegen robots.txt pruefen. */
const AI_AGENTS = [
  { ua: "GPTBot", who: "OpenAI (ChatGPT index)" },
  { ua: "OAI-SearchBot", who: "ChatGPT Search" },
  { ua: "ChatGPT-User", who: "ChatGPT fetching live" },
  { ua: "ClaudeBot", who: "Anthropic (Claude)" },
  { ua: "Claude-User", who: "Claude fetching live" },
  { ua: "PerplexityBot", who: "Perplexity" },
  { ua: "Google-Extended", who: "Google Gemini and AI Overviews" },
  { ua: "Applebot-Extended", who: "Apple Intelligence" },
  { ua: "Bingbot", who: "Microsoft Copilot" },
  { ua: "CCBot", who: "Common Crawl, the training base of many models" },
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

// Uebersetzt ein robots.txt-Muster in einen regulaeren Ausdruck.
// "*" steht fuer beliebig viele Zeichen, "$" am Ende verankert das Pfadende.
// Ein reiner Praefix-Vergleich reicht nicht: das Muster /*/config/ wuerde dabei
// auf "/" verkuerzt und damit die ganze Domain sperren.
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

/** robots.txt-Auswertung: laengstes passendes Muster gewinnt, bei Gleichstand "allow". */
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

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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

  // JSON-LD einsammeln, kaputte Bloecke merken statt verschlucken.
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
    // Styles und noscript. Pruefungen, die "den Text der Seite" meinen, nehmen den.
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
/* Die Pruefungen                                                      */
/* ------------------------------------------------------------------ */

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";
const NA = "na";

export const CHECKS = [
  /* ---------------- AI access ---------------- */
  {
    id: "http-status",
    cat: "access",
    weight: 3,
    title: "Page returns a clean response",
    why: "If the URL does not answer with 200, no crawler indexes the content — everything else is moot.",
    run: (c) => {
      const s = c.payload.status;
      if (s >= 400) return { status: FAIL, detail: `The page responds with HTTP ${s}.` };
      if (c.payload.redirected)
        return {
          status: WARN,
          detail: `Redirects to ${c.payload.finalUrl}. Link the destination directly, otherwise every request takes a detour.`,
        };
      return { status: PASS, detail: `HTTP ${s}, no redirect.` };
    },
  },
  {
    id: "https",
    cat: "access",
    weight: 1,
    title: "HTTPS",
    why: "Several AI crawlers skip or downrank pages served over plain HTTP.",
    run: (c) =>
      c.pageUrl.protocol === "https:"
        ? { status: PASS, detail: "The page is served over HTTPS." }
        : { status: FAIL, detail: "The page is served over unencrypted HTTP." },
  },
  {
    id: "content-in-html",
    cat: "access",
    weight: 3,
    title: "Content sits in the HTML, not only in JavaScript",
    why: "GPTBot, ClaudeBot and PerplexityBot do not run JavaScript. Whatever the browser fetches afterwards does not exist for them.",
    run: (c) => {
      const w = c.wordCount;
      const spaRoot = !!c.doc.querySelector(
        "#root:empty, #app:empty, #__next:empty, [data-reactroot]:empty",
      );
      if (w < 120 || spaRoot)
        return {
          status: FAIL,
          detail: `Only ${w} words of text in the delivered HTML. The content is loaded by JavaScript and is invisible to AI crawlers.`,
        };
      if (w < 350)
        return {
          status: WARN,
          detail: `Only ${w} words in the raw HTML. Check whether part of the content is rendered client-side.`,
        };
      return { status: PASS, detail: `${w} words sit in the HTML itself.` };
    },
  },
  {
    id: "robots-present",
    cat: "access",
    weight: 1,
    title: "robots.txt present",
    why: "Without a robots.txt you have no control over which AI crawler may read what.",
    run: (c) =>
      c.robotsTxt
        ? { status: PASS, detail: "robots.txt is reachable." }
        : {
            status: WARN,
            detail:
              "No robots.txt found. Crawlers may read everything, but nothing is under your control.",
          },
  },
  {
    id: "robots-ai",
    cat: "access",
    weight: 3,
    title: "AI crawlers are not locked out",
    why: "A single 'Disallow: /' for GPTBot is enough to disappear from ChatGPT entirely.",
    run: (c) => {
      if (!c.robotsGroups)
        return {
          status: PASS,
          detail: "No robots.txt, so nothing is technically blocked.",
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
          detail: `All ${AI_AGENTS.length} AI crawlers checked may read this page.`,
        };
      return {
        status: FAIL,
        detail: `${plural(blocked.length, "AI crawler is", "AI crawlers are")} blocked for this path.`,
        evidence: blocked.map((b) => `${b.ua} — ${b.who}`),
      };
    },
  },
  {
    id: "meta-robots",
    cat: "access",
    weight: 3,
    title: "No noindex or nosnippet",
    why: "'nosnippet' forbids any verbatim reproduction. The page can then no longer be quoted, even while it stays indexed.",
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
          detail: `The page sets: ${hits.join(", ")}.`,
          evidence: [vals.replace(/^,+|,+$/g, "") || "(empty)"],
        };
      return { status: PASS, detail: "No restrictive robots directives found." };
    },
  },
  {
    id: "llms-txt",
    cat: "access",
    weight: 2,
    title: "llms.txt present",
    why: "An /llms.txt sums up for language models what the site is and which pages matter. Not a standard yet, but read more and more often.",
    run: (c) =>
      c.llmsTxt && c.llmsTxt.trim().length > 40
        ? { status: PASS, detail: `llms.txt present, ${c.llmsTxt.trim().length} characters.` }
        : {
            status: WARN,
            detail:
              "No /llms.txt found. Cheapest lever there is: a Markdown file with a short description and links to your most important pages.",
          },
  },
  {
    id: "sitemap",
    cat: "access",
    weight: 2,
    title: "Sitemap reachable",
    why: "The sitemap is how crawlers find pages that are not prominently linked anywhere.",
    run: (c) => {
      const inRobots = c.robotsTxt && /^\s*sitemap:/im.test(c.robotsTxt);
      if (c.payload.sitemap.ok || inRobots)
        return {
          status: PASS,
          detail: inRobots
            ? "Sitemap is declared in robots.txt."
            : "sitemap.xml is reachable.",
        };
      return {
        status: WARN,
        detail: "Neither /sitemap.xml reachable nor a sitemap declared in robots.txt.",
      };
    },
  },
  {
    id: "html-lang",
    cat: "access",
    weight: 1,
    title: "Language declared",
    why: "Without a lang attribute the model has to guess the language, and on short pages that goes wrong.",
    run: (c) => {
      const lang = c.doc.documentElement.getAttribute("lang");
      return lang
        ? { status: PASS, detail: `<html lang="${lang}">` }
        : { status: WARN, detail: "The <html> element has no lang attribute." };
    },
  },

  /* ---------------- Structure ---------------- */
  {
    id: "h1",
    cat: "structure",
    weight: 3,
    title: "Exactly one H1",
    why: "To a model the H1 is the title of the passage it quotes. None or several make that reference ambiguous.",
    run: (c) => {
      const n = c.headings.filter((h) => h.level === 1).length;
      if (n === 1)
        return {
          status: PASS,
          detail: `One H1: “${c.headings.find((h) => h.level === 1).text.slice(0, 90)}”`,
        };
      if (n === 0) return { status: FAIL, detail: "The page has no H1." };
      return { status: WARN, detail: `The page has ${n} H1 elements.` };
    },
  },
  {
    id: "heading-order",
    cat: "structure",
    weight: 2,
    title: "Headings without skipped levels",
    why: "Models infer what belongs to what from the order of heading levels. A jump from H2 to H4 tears that apart.",
    run: (c) => {
      const jumps = [];
      let prev = 0;
      for (const h of c.headings) {
        if (prev && h.level > prev + 1)
          jumps.push(`H${prev} → H${h.level}: “${h.text.slice(0, 60)}”`);
        prev = h.level;
      }
      if (!c.headings.length) return { status: FAIL, detail: "No headings found." };
      return jumps.length
        ? {
            status: WARN,
            detail: `${plural(jumps.length, "skipped level", "skipped levels")} in the heading order.`,
            evidence: jumps.slice(0, 5),
          }
        : { status: PASS, detail: `${c.headings.length} headings in clean order.` };
    },
  },
  {
    id: "chunking",
    cat: "structure",
    weight: 3,
    title: "Text split into quotable sections",
    why: "AI systems break pages into passages. Long blocks without a subheading are too unspecific as a whole and get dropped.",
    run: (c) => {
      const subs = c.headings.filter((h) => h.level >= 2 && h.level <= 4).length;
      if (c.wordCount < 150) return { status: NA, detail: "Too little text to judge this." };
      const perSection = Math.round(c.wordCount / (subs + 1));
      if (perSection > 600)
        return {
          status: FAIL,
          detail: `${perSection} words per section on average across ${subs} subheadings. Aim for under 300.`,
        };
      if (perSection > 300)
        return {
          status: WARN,
          detail: `${perSection} words per section on average. More subheadings would help.`,
        };
      return {
        status: PASS,
        detail: `${perSection} words per section on average across ${subs} subheadings.`,
      };
    },
  },
  {
    id: "semantic-html",
    cat: "structure",
    weight: 2,
    title: "Semantic markup",
    why: "<main> and <article> separate the content from navigation and footer. Without them a model will happily quote the cookie banner.",
    run: (c) => {
      const found = ["main", "article", "header", "footer", "nav", "section"].filter((t) =>
        c.doc.querySelector(t),
      );
      const hasMain = found.includes("main") || found.includes("article");
      if (hasMain) return { status: PASS, detail: `Found: <${found.join(">, <")}>` };
      return {
        status: WARN,
        detail: found.length
          ? `Only <${found.join(">, <")}> — there is no <main> or <article> marking the content area.`
          : "No semantic regions at all, everything sits in <div>.",
      };
    },
  },
  {
    id: "lists-tables",
    cat: "structure",
    weight: 2,
    title: "Lists and tables",
    why: "Bullet lists and tables are the format language models pick up and reproduce most reliably.",
    run: (c) => {
      const lists = c.doc.querySelectorAll("ul li, ol li").length;
      const tables = c.doc.querySelectorAll("table").length;
      if (lists >= 5 || tables >= 1)
        return {
          status: PASS,
          detail: `${lists} list items, ${plural(tables, "table", "tables")}.`,
        };
      if (lists > 0)
        return { status: WARN, detail: `Only ${lists} list items and no tables.` };
      return { status: FAIL, detail: "Neither lists nor tables, just running text." };
    },
  },
  {
    id: "content-length",
    cat: "structure",
    weight: 2,
    title: "Enough content",
    why: "Below roughly 300 words there is not enough context for a model to draw a solid answer from.",
    run: (c) => {
      if (c.wordCount >= 300)
        return { status: PASS, detail: `${c.wordCount} words of content.` };
      if (c.wordCount >= 150)
        return { status: WARN, detail: `Only ${c.wordCount} words of content.` };
      return { status: FAIL, detail: `Only ${c.wordCount} words of content.` };
    },
  },
  {
    id: "question-headings",
    cat: "structure",
    weight: 2,
    title: "Headings phrased as questions",
    why: "People ask questions. A heading that carries the question verbatim matches the prompt directly.",
    run: (c) => {
      const re = /^(what|how|why|when|where|who|which|can|is|are|does|do|should|will|was|wie|warum|wieso|wann|wo|welche[rsn]?|wer|kann|sind|gibt|darf|muss)\b/i;
      const qs = c.headings.filter((h) => h.text.endsWith("?") || re.test(h.text));
      if (qs.length >= 2)
        return {
          status: PASS,
          detail: `${qs.length} headings phrased as questions.`,
          evidence: qs.slice(0, 4).map((h) => h.text.slice(0, 80)),
        };
      if (qs.length === 1)
        return { status: WARN, detail: "Only one heading is phrased as a question." };
      return { status: WARN, detail: "No heading phrases a user question." };
    },
  },
  {
    id: "text-ratio",
    cat: "structure",
    weight: 1,
    title: "Text to markup ratio",
    why: "A lot of markup around a little text points to a page-builder export in which the content gets lost.",
    run: (c) => {
      const ratio = c.bodyText.length / Math.max(1, c.payload.html.length);
      const pct = (ratio * 100).toFixed(1);
      if (ratio >= 0.08) return { status: PASS, detail: `${pct} % of the page is text.` };
      if (ratio >= 0.03) return { status: WARN, detail: `Only ${pct} % of the page is text.` };
      return {
        status: FAIL,
        detail: `Only ${pct} % of the page is text, the rest is markup.`,
      };
    },
  },

  /* ---------------- Structured data ---------------- */
  {
    id: "jsonld",
    cat: "schema",
    weight: 3,
    title: "JSON-LD present",
    why: "Structured data is the one place where you tell a machine unambiguously what the page is.",
    run: (c) => {
      if (c.ldBroken && !c.ldNodes.length)
        return {
          status: FAIL,
          detail: `${plural(c.ldBroken, "JSON-LD block", "JSON-LD blocks")} present, but none of them parseable.`,
        };
      if (!c.ldNodes.length) return { status: FAIL, detail: "No JSON-LD on the page." };
      const t = [...c.ldTypes];
      return {
        status: c.ldBroken ? WARN : PASS,
        detail: c.ldBroken
          ? `${c.ldScriptCount} blocks, ${c.ldBroken} of them malformed.`
          : `${plural(c.ldScriptCount, "JSON-LD block", "JSON-LD blocks")} covering ${plural(t.length, "type", "types")}.`,
        evidence: t.slice(0, 12),
      };
    },
  },
  {
    id: "schema-entity",
    cat: "schema",
    weight: 3,
    title: "The publisher is declared",
    why: "Organization or LocalBusiness ties the page to a real entity. Without it the source stays anonymous to a model.",
    run: (c) => {
      const hit = [
        "Organization",
        "LocalBusiness",
        "Corporation",
        "Person",
        "WebSite",
        "Store",
        "Brand",
      ].filter((t) => [...c.ldTypes].some((x) => x === t || x.endsWith(t)));
      return hit.length
        ? { status: PASS, detail: `Declared as: ${hit.join(", ")}.` }
        : {
            status: FAIL,
            detail: "No Organization, Person or WebSite in the structured data.",
          };
    },
  },
  {
    id: "schema-pagetype",
    cat: "schema",
    weight: 2,
    title: "The page type is declared",
    why: "Article, Product or FAQPage tell the model what kind of answer it can take from here.",
    run: (c) => {
      const kinds = [
        "Article", "BlogPosting", "NewsArticle", "Product", "FAQPage", "HowTo",
        "Service", "Event", "Recipe", "WebPage", "CollectionPage", "AboutPage",
        "ContactPage", "ItemList",
      ];
      const hit = kinds.filter((t) => c.ldTypes.has(t));
      return hit.length
        ? { status: PASS, detail: `Page type: ${hit.join(", ")}.` }
        : { status: WARN, detail: "No content page type declared." };
    },
  },
  {
    id: "schema-breadcrumb",
    cat: "schema",
    weight: 1,
    title: "Breadcrumb",
    why: "The breadcrumb shows where the page sits in the wider site, context a model would otherwise have to guess.",
    run: (c) =>
      c.ldTypes.has("BreadcrumbList")
        ? { status: PASS, detail: "BreadcrumbList present." }
        : { status: WARN, detail: "No BreadcrumbList declared." },
  },
  {
    id: "title",
    cat: "schema",
    weight: 3,
    title: "Title tag",
    why: "The title is usually the line an AI uses to name the source.",
    run: (c) => {
      const t = (c.doc.querySelector("title")?.textContent || "").trim();
      if (!t) return { status: FAIL, detail: "No title tag." };
      if (t.length < 15)
        return { status: WARN, detail: `Very short at ${t.length} characters: “${t}”` };
      if (t.length > 70)
        return {
          status: WARN,
          detail: `Very long at ${t.length} characters.`,
          evidence: [t],
        };
      return { status: PASS, detail: `“${t}” (${t.length} characters)` };
    },
  },
  {
    id: "description",
    cat: "schema",
    weight: 3,
    title: "Meta description",
    why: "The description is often the first block of text a model processes about the page at all.",
    run: (c) => {
      const d = c.meta("description") || c.prop("og:description");
      if (!d) return { status: FAIL, detail: "No meta description set." };
      if (d.length < 50)
        return { status: WARN, detail: `Only ${d.length} characters: “${d}”` };
      if (d.length > 175)
        return {
          status: WARN,
          detail: `${d.length} characters, which will be truncated.`,
          evidence: [d],
        };
      return { status: PASS, detail: `${d.length} characters.`, evidence: [d] };
    },
  },
  {
    id: "canonical",
    cat: "schema",
    weight: 2,
    title: "Canonical URL",
    why: "Without a canonical, authority spreads across variants of the same page, and the wrong one may end up being quoted.",
    run: (c) => {
      const href = c.doc.querySelector('link[rel="canonical" i]')?.getAttribute("href");
      if (!href) return { status: WARN, detail: "No canonical URL set." };
      try {
        const abs = new URL(href, c.pageUrl);
        return { status: PASS, detail: abs.toString() };
      } catch {
        return { status: WARN, detail: `Canonical is not a valid URL: “${href}”` };
      }
    },
  },
  {
    id: "open-graph",
    cat: "schema",
    weight: 1,
    title: "Open Graph data",
    why: "OG tags are a second, redundant channel for title and description, which helps when the HTML itself is messy.",
    run: (c) => {
      const have = ["og:title", "og:description", "og:image", "og:type"].filter((p) =>
        c.prop(p),
      );
      if (have.length >= 3) return { status: PASS, detail: `Set: ${have.join(", ")}.` };
      if (have.length) return { status: WARN, detail: `Only ${have.join(", ")} set.` };
      return { status: WARN, detail: "No Open Graph tags." };
    },
  },

  /* ---------------- Citability ---------------- */
  {
    id: "author",
    cat: "authority",
    weight: 2,
    title: "Author is identifiable",
    why: "Models favour sources with a named author. Anonymous text gets quoted less often.",
    run: (c) => {
      const fromLd = c.ldNodes.find((n) => n.author || n.creator || n.publisher);
      const metaAuthor = c.meta("author");
      const relAuthor = c.doc.querySelector(
        '[rel="author"], [itemprop="author"], .author, .byline',
      );
      if (fromLd) {
        const a = fromLd.author || fromLd.creator || fromLd.publisher;
        const name = typeof a === "string" ? a : a?.name || "(no name given)";
        return { status: PASS, detail: `From structured data: ${name}` };
      }
      if (metaAuthor) return { status: PASS, detail: `meta[author]: ${metaAuthor}` };
      if (relAuthor)
        return {
          status: WARN,
          detail: "Author appears in the markup only, not in structured data.",
        };
      return { status: FAIL, detail: "Neither an author nor a publisher is identifiable." };
    },
  },
  {
    id: "dates",
    cat: "authority",
    weight: 2,
    title: "Date present and current",
    why: "Without a date a model cannot judge how current the page is, and reaches for dated competition instead.",
    run: (c) => {
      const cand = [];
      for (const n of c.ldNodes) {
        for (const k of ["dateModified", "datePublished", "uploadDate"])
          if (n[k]) cand.push(n[k]);
      }
      const t = c.doc.querySelector("time[datetime]")?.getAttribute("datetime");
      if (t) cand.push(t);
      const pub = c.prop("article:modified_time") || c.prop("article:published_time");
      if (pub) cand.push(pub);

      if (!cand.length)
        return { status: WARN, detail: "No machine-readable date on the page." };
      const newest = cand
        .map((d) => new Date(d))
        .filter((d) => !isNaN(d))
        .sort((a, b) => b - a)[0];
      if (!newest)
        return { status: WARN, detail: `A date is present but unreadable: ${cand[0]}` };
      const months = (Date.now() - newest) / (1000 * 60 * 60 * 24 * 30.4);
      const shown = newest.toISOString().slice(0, 10);
      if (months > 24)
        return { status: WARN, detail: `Last modified ${shown}, over two years ago.` };
      return { status: PASS, detail: `Last modified: ${shown}` };
    },
  },
  {
    id: "citations",
    cat: "authority",
    weight: 2,
    title: "Outbound sources",
    why: "Pages that cite sources themselves are rated more trustworthy by AI systems.",
    run: (c) => {
      const social =
        /(facebook|instagram|twitter|x\.com|linkedin|youtube|tiktok|pinterest|whatsapp)\./i;
      const refs = c.links.external.filter((u) => !social.test(u.hostname));
      const hosts = [...new Set(refs.map((u) => u.hostname))];
      if (hosts.length >= 3)
        return {
          status: PASS,
          detail: `Links out to ${hosts.length} external sources.`,
          evidence: hosts.slice(0, 6),
        };
      if (hosts.length >= 1)
        return {
          status: WARN,
          detail: `Only ${plural(hosts.length, "external source", "external sources")}.`,
          evidence: hosts,
        };
      return { status: WARN, detail: "No external sources linked." };
    },
  },
  {
    id: "specifics",
    cat: "authority",
    weight: 2,
    title: "Concrete figures in the text",
    why: "Numbers, measurements and prices are what an AI takes verbatim. Pure marketing language offers nothing to quote.",
    run: (c) => {
      const hits =
        c.text.match(
          /\b\d[\d.,]*\s?(%|mm|cm|m²|m2|m\b|kg|lbs?|db|dB|€|\$|£|eur|euro|usd|hrs?|hours?|minutes?|years?|days?|std|stunden|minuten|jahre|tage|watt|w\b)/gi,
        ) || [];
      if (c.wordCount < 100) return { status: NA, detail: "Too little text to judge this." };
      if (hits.length >= 5)
        return {
          status: PASS,
          detail: `${hits.length} concrete figures in the text.`,
          evidence: [...new Set(hits)].slice(0, 8),
        };
      if (hits.length >= 2)
        return { status: WARN, detail: `Only ${hits.length} concrete figures in the text.` };
      return {
        status: WARN,
        detail: "Barely any concrete numbers or measurements, so there is little to quote.",
      };
    },
  },
  {
    id: "direct-answer",
    cat: "authority",
    weight: 3,
    title: "Direct answer at the top",
    why: "The first paragraph after the H1 is the passage most often pulled as an answer. It should carry the core statement in two or three sentences.",
    run: (c) => {
      const scope = c.mainNode || c.doc;
      const ps = [...scope.querySelectorAll("p")]
        .map((p) => (p.textContent || "").replace(/\s+/g, " ").trim())
        .filter((t) => words(t) >= 8);
      if (!ps.length)
        return {
          status: FAIL,
          detail: "No coherent paragraph found, the page is made of fragments.",
        };
      const first = ps[0];
      const w = words(first);
      if (w > 120)
        return {
          status: WARN,
          detail: `The first paragraph runs to ${w} words, too long for a direct answer.`,
          evidence: [first.slice(0, 200) + "…"],
        };
      if (w < 15)
        return {
          status: WARN,
          detail: `The first paragraph is only ${w} words.`,
          evidence: [first],
        };
      return { status: PASS, detail: `First paragraph: ${w} words.`, evidence: [first.slice(0, 220)] };
    },
  },
  {
    id: "faq",
    cat: "authority",
    weight: 2,
    title: "Question and answer block",
    why: "An FAQ section hands over ready-made answer pairs, the format AI systems adopt most directly.",
    run: (c) => {
      if (c.ldTypes.has("FAQPage") || c.ldTypes.has("Question"))
        return { status: PASS, detail: "The FAQ is declared as structured data." };
      const details = c.doc.querySelectorAll("details summary").length;
      const qHeads = c.headings.filter((h) => h.text.endsWith("?")).length;
      if (details >= 3 || qHeads >= 3)
        return {
          status: WARN,
          detail: `FAQ structure visible in the markup with ${details || qHeads} entries, but not declared as FAQPage.`,
        };
      return { status: WARN, detail: "No question and answer section on the page." };
    },
  },
  {
    id: "imprint",
    cat: "authority",
    weight: 1,
    title: "Legal and contact pages linked",
    why: "Being reachable and stating who you are is a classic trust signal that feeds into how a source is rated.",
    run: (c) => {
      const re =
        /(impressum|kontakt|contact|about|ueber-uns|über-uns|legal|imprint|datenschutz|privacy)/i;
      const hit = c.links.internal.filter((u) => re.test(u.pathname));
      const paths = [...new Set(hit.map((u) => u.pathname))];
      return paths.length
        ? { status: PASS, detail: `Linked: ${paths.slice(0, 4).join(", ")}` }
        : { status: WARN, detail: "Neither a contact, about nor legal page is linked." };
    },
  },
  {
    id: "image-alt",
    cat: "authority",
    weight: 1,
    title: "Alt text on images",
    why: "Alt text is a language model's only way into what an image shows.",
    run: (c) => {
      const imgs = [...c.doc.querySelectorAll("img")];
      if (!imgs.length) return { status: NA, detail: "No images on the page." };
      const withAlt = imgs.filter((i) => (i.getAttribute("alt") || "").trim().length > 0).length;
      const pct = Math.round((withAlt / imgs.length) * 100);
      const line = `${withAlt} of ${imgs.length} images carry alt text (${pct} %).`;
      if (pct >= 90) return { status: PASS, detail: line };
      if (pct >= 50) return { status: WARN, detail: `Only ${line}` };
      return { status: FAIL, detail: `Only ${line}` };
    },
  },
  {
    id: "internal-links",
    cat: "authority",
    weight: 1,
    title: "Internal linking",
    why: "Internal links show the crawler the rest of the site and build topical context around the page.",
    run: (c) => {
      const n = new Set(c.links.internal.map((u) => u.pathname)).size;
      if (n >= 5) return { status: PASS, detail: `${n} distinct internal targets linked.` };
      if (n >= 2) return { status: WARN, detail: `Only ${n} internal targets linked.` };
      return { status: FAIL, detail: "Practically no internal linking." };
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
      r = { status: NA, detail: `Could not be evaluated (${err.message}).` };
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
