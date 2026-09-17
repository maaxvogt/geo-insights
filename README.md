# GEO Insights

Kostenloser GEO-Check für eine einzelne URL, im Aufbau und Stil von
[PageSpeed Insights](https://pagespeed.web.dev/). URL eingeben, Bericht bekommen.

GEO = Generative Engine Optimization: Wie gut kann ein KI-System (ChatGPT,
Claude, Perplexity, Google AI Overviews) die Seite **abrufen, verstehen und
zitieren**?

## Aufbau

```
docs/      Statische Oberfläche → GitHub Pages
  assets/checks.js   34 regelbasierte Prüfungen (läuft im Browser)
  assets/app.js      Ablauf, Rendering, Copy-Link
worker/    Cloudflare Worker als Fetch-Proxy
```

**Warum ein Worker?** GitHub Pages ist rein statisch. Ein Browser darf fremdes
HTML nicht per `fetch()` laden, weil die Zielseiten keinen
`Access-Control-Allow-Origin`-Header senden. Der Worker holt die Seite
serverseitig und gibt sie mit CORS-Headern zurück. Die Auswertung selbst läuft
komplett im Browser — es geht nichts an einen Server, es wird nichts
gespeichert.

## Was geprüft wird

| Kategorie | Gewicht | Inhalt |
|---|---|---|
| KI-Zugang | 30 % | robots.txt gegen 11 KI-Crawler, `noindex`/`nosnippet`, llms.txt, Sitemap, Inhalt ohne JavaScript |
| Struktur | 25 % | H1, Ebenenfolge, Abschnittslänge, semantisches HTML, Listen/Tabellen, Frage-Überschriften |
| Strukturierte Daten | 25 % | JSON-LD, Organization, Seitentyp, Breadcrumb, Title, Description, Canonical, Open Graph |
| Zitierfähigkeit | 20 % | Autor, Datum, externe Belege, konkrete Zahlen, direkte Antwort oben, FAQ, Impressum, Alt-Texte |

Bewertet wird das **rohe HTML** — genau das, was KI-Crawler bekommen. Sie führen
kein JavaScript aus.

Das Tool sagt, ob eine Seite technisch und strukturell zitierfähig ist. Es sagt
nicht, ob ChatGPT sie heute tatsächlich nennt — das hängt zusätzlich an Marke,
Verlinkung und Wettbewerb.

## Entwickeln

```bash
# Proxy lokal
cd worker && wrangler dev --port 8787

# Oberfläche lokal
cd docs && python3 -m http.server 8080
open "http://127.0.0.1:8080/?api=http://127.0.0.1:8787"
```

Der `?api=`-Parameter überschreibt den Proxy-Endpunkt; ohne ihn zeigt die Seite
auf den deployten Worker.

## Deployen

```bash
cd worker && wrangler deploy     # Proxy
git push                         # GitHub Pages baut docs/ automatisch
```

Der Cloudflare-Account ist in `wrangler.toml` und `.claude/wrangler-account`
festgenagelt — hier sind zwei Accounts im Wechsel eingeloggt.

## Grenzen des Proxys

Der Endpunkt ist öffentlich und deshalb eng gefasst: nur GET, nur http/https auf
Standardports, keine internen oder privaten Adressen (SSRF), nur Text-Antworten,
3 MB Limit, 12 s Timeout, 20 Analysen pro Minute und IP. Client-Header, Cookies
und Zugangsdaten werden nie weitergereicht.
