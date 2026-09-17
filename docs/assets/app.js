import { analyze, CATEGORIES, scoreClass } from "./checks.js";

/* Der Proxy-Endpunkt. Ueberschreibbar per ?api=... fuer lokale Tests. */
const DEFAULT_API = "https://geo-insights-api.poddie.workers.dev";
const API = new URLSearchParams(location.search).get("api") || DEFAULT_API;

const $ = (id) => document.getElementById(id);
const el = {
  form: $("form"), url: $("url"), submit: $("submit"),
  hero: $("hero"),
  loading: $("loading"), loadingText: $("loading-text"),
  error: $("error"), errorText: $("error-text"),
  report: $("report"), link: $("report-link"), stamp: $("report-stamp"),
  summary: $("summary"), categories: $("categories"),
  copy: $("copy"), toast: $("toast"),
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

/* ---------------- Gauge ---------------- */

function gauge(score, label, big = false) {
  const r = big ? 46 : 44;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  const cls = scoreClass(score);
  return `
    <div class="gauge-wrap${big ? " big" : ""}">
      <div class="gauge ${cls}">
        <svg viewBox="0 0 100 100" role="img" aria-label="${esc(label)}: ${score} out of 100">
          <circle class="track" cx="50" cy="50" r="${r}"></circle>
          <circle class="arc" cx="50" cy="50" r="${r}"
                  stroke-dasharray="${c.toFixed(1)}"
                  stroke-dashoffset="${c.toFixed(1)}"
                  data-offset="${off.toFixed(1)}"
                  transform="rotate(-90 50 50)"></circle>
        </svg>
        <div class="gauge-num">${score}</div>
      </div>
      <div class="gauge-label">${esc(label)}</div>
    </div>`;
}

/* ---------------- Bericht rendern ---------------- */

const ORDER = { fail: 0, warn: 1, na: 2, pass: 3 };

function auditRow(check) {
  const mark = check.status === "warn" ? "warn" : check.status;
  const evidence = check.evidence?.length
    ? `<ul class="evidence">${check.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="audit" data-audit>
      <button class="audit-head" type="button" aria-expanded="false">
        <span class="mark ${mark}" aria-hidden="true"></span>
        <span class="audit-text">
          <span class="audit-title">${esc(check.title)}</span>
          <span class="audit-detail">${esc(check.detail)}</span>
        </span>
        <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
        </svg>
      </button>
      <div class="audit-body">
        <p class="audit-why">${esc(check.why)}</p>
        ${evidence}
      </div>
    </div>`;
}

function render(result, payload) {
  const { categories, overall } = result;

  el.summary.innerHTML =
    gauge(overall, "GEO score", true) +
    categories.map((c) => gauge(c.score, c.label)).join("");

  el.categories.innerHTML = categories
    .map((cat) => {
      const sorted = [...cat.checks].sort(
        (a, b) => ORDER[a.status] - ORDER[b.status] || b.weight - a.weight,
      );
      const open = sorted.filter((c) => c.status !== "pass");
      const passed = sorted.filter((c) => c.status === "pass");

      const openHtml = open.length
        ? `<div class="group-title">${open.length} ${open.length === 1 ? "thing" : "things"} to fix</div>` +
          open.map(auditRow).join("")
        : `<div class="group-title">Nothing outstanding here.</div>`;

      const passedHtml = passed.length
        ? `<details class="passed-group">
             <summary>Passed checks (${passed.length})</summary>
             ${passed.map(auditRow).join("")}
           </details>`
        : "";

      return `
        <section class="cat">
          <div class="cat-head">
            <h2>${esc(cat.label)}</h2>
            <span class="cat-score ${scoreClass(cat.score)}">${cat.score}/100</span>
          </div>
          <p class="cat-blurb">${esc(cat.blurb)}</p>
          ${openHtml}
          ${passedHtml}
        </section>`;
    })
    .join("");

  el.link.textContent = payload.finalUrl;
  el.link.href = payload.finalUrl;

  // Bewusst "17 Sep 2026" statt eines Zahlenformats: 9/17 gegen 17/9 liest
  // je nach Herkunft verschieden, der Monatsname ist eindeutig.
  const when = new Date(payload.fetchedAt);
  const day = when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  el.stamp.textContent =
    `Fetched ${day} at ${time} · ${payload.fetchMs} ms · ` +
    `${(payload.html.length / 1024).toFixed(0)} kB of HTML` +
    (payload.truncated ? " (truncated)" : "");

  el.report.hidden = false;

  // Gauge-Arcs erst nach dem Einhaengen animieren.
  requestAnimationFrame(() => {
    document.querySelectorAll(".gauge .arc").forEach((arc) => {
      arc.style.strokeDashoffset = arc.dataset.offset;
    });
  });
}

/* Ein Delegate fuer alle Aufklapper – ueberlebt jedes Neu-Rendern. */
el.categories.addEventListener("click", (e) => {
  const head = e.target.closest(".audit-head");
  if (!head) return;
  const audit = head.closest("[data-audit]");
  const open = audit.getAttribute("open-state") === "1";
  audit.setAttribute("open-state", open ? "0" : "1");
  head.setAttribute("aria-expanded", String(!open));
});

/* ---------------- Ablauf ---------------- */

function normalize(input) {
  let v = input.trim();
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  return v;
}

function setBusy(on, text) {
  el.loading.hidden = !on;
  el.submit.disabled = on;
  el.submit.textContent = on ? "Working …" : "Analyze";
  if (text) el.loadingText.textContent = text;
}

function showError(msg) {
  el.errorText.textContent = msg;
  el.error.hidden = false;
}

async function run(rawUrl, { pushState = true } = {}) {
  const target = normalize(rawUrl);
  if (!target) return;

  el.url.value = target;
  el.error.hidden = true;
  el.report.hidden = true;
  el.hero.hidden = true;
  setBusy(true, "Fetching the page …");

  if (pushState) {
    const u = new URL(location.href);
    u.searchParams.set("url", target);
    history.pushState({ url: target }, "", u);
  }
  document.title = `${new URL(target).hostname} – GEO Insights`;

  try {
    const res = await fetch(`${API}/api/inspect?url=${encodeURIComponent(target)}`);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showError(data.error || `The fetch failed with HTTP ${res.status}.`);
      return;
    }

    setBusy(true, "Evaluating the HTML …");
    const result = analyze(data);
    render(result, data);
  } catch (err) {
    showError(
      `The analysis service is unreachable (${err.message}). Is the worker running at ${API}?`,
    );
  } finally {
    setBusy(false);
  }
}

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  run(el.url.value);
});

el.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
  } catch {
    // Aelterer Fallback, u. a. Safari ohne sicheren Kontext.
    const ta = document.createElement("textarea");
    ta.value = location.href;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  el.toast.classList.add("show");
  setTimeout(() => el.toast.classList.remove("show"), 1800);
});

window.addEventListener("popstate", () => {
  const u = new URLSearchParams(location.search).get("url");
  if (u) run(u, { pushState: false });
  else location.reload();
});

/* Geteilter Link: direkt loslegen. */
const initial = new URLSearchParams(location.search).get("url");
if (initial) run(initial, { pushState: false });
