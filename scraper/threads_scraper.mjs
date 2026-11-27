#!/usr/bin/env node
/**
 * ҚазҰУ Threads скрапері (GitHub Actions үшін)
 * ============================================
 * Шынайы браузерде (Chromium) БӨЛЕК аккаунттың cookies-імен Threads іздеуін ашып,
 * табылған жазбаларды Cloudflare ботына (/ingest) жібереді. Жаман сөз сүзгісі,
 * қайталамау және апайға жіберу — бәрі Cloudflare ботында.
 *
 * Орта айнымалылары (GitHub Secrets):
 *   THREADS_COOKIES  — аккаунттың cookies (Cookie-Editor JSON экспорты немесе "a=1; b=2" жолы)
 *   INGEST_URL       — https://kaznu-bot.<...>.workers.dev/ingest
 *   INGEST_KEY       — /setup бетінде көрсетілген кілт
 *   QUERIES          — (міндетті емес) "КазНУ,ҚазҰУ,KazNU"
 */
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";

const baseUrl = () => (process.env.BASE_URL || "https://www.threads.com").replace(/\/$/, "");
const DEFAULT_QUERIES = ["КазНУ", "ҚазҰУ", "KazNU", "КазГУ"];

/* ---------------- cookies ---------------- */
const SAME_SITE = { no_restriction: "None", none: "None", lax: "Lax", strict: "Strict" };

export function parseCookies(raw, domain = ".threads.com") {
  raw = String(raw || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = arr.cookies || [];
    return arr.filter((c) => c && c.name && c.value !== undefined).map((c) => {
      const out = {
        name: String(c.name), value: String(c.value),
        domain: c.domain || domain, path: c.path || "/",
        httpOnly: Boolean(c.httpOnly), secure: c.secure !== false,
      };
      const exp = c.expirationDate ?? c.expires;
      if (typeof exp === "number" && exp > 0) out.expires = Math.floor(exp);
      const ss = SAME_SITE[String(c.sameSite || "").toLowerCase()];
      if (ss) out.sameSite = ss;
      if (out.sameSite === "None") out.secure = true;
      return out;
    });
  }
  return raw.split(/;\s*/).filter((kv) => kv.includes("=")).map((kv) => {
    const i = kv.indexOf("=");
    return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain, path: "/", secure: true };
  });
}

/* ---------------- беттен жазбаларды оқу (браузер ішінде орындалады) ---------------- */
export function extractPostsInPage() {
  const RE = /^\/@([^/]+)\/post\/([^/?#]+)/;
  const codeOf = (a) => {
    try {
      const m = new URL(a.getAttribute("href"), location.origin).pathname.match(RE);
      return m ? { user: decodeURIComponent(m[1]), code: m[2] } : null;
    } catch (_) { return null; }
  };
  const out = new Map();
  for (const a of document.querySelectorAll('a[href*="/post/"]')) {
    const c = codeOf(a);
    if (!c || out.has(c.code)) continue;
    // Жазбаның «қорабы»: тек осы бір жазбаға сілтеме бар ең үлкен ата-элемент
    let box = a;
    let el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      const parent = el.parentElement;
      const codes = new Set();
      for (const x of parent.querySelectorAll('a[href*="/post/"]')) {
        const cx = codeOf(x);
        if (cx) codes.add(cx.code);
        if (codes.size > 1) break;
      }
      if (codes.size > 1) break;
      el = parent;
      box = parent;
    }
    const time = box.querySelector("time[datetime]");
    out.set(c.code, {
      code: c.code, username: c.user, rawText: (box.innerText || "").trim(),
      timestamp: time ? time.getAttribute("datetime") : null,
    });
  }
  return [...out.values()];
}

/* ---------------- мәтінді тазалау ---------------- */
const NOISE = new Set(["translate", "перевести", "аудару", "аударманы көру", "see translation", "показать перевод",
  "more", "ещё", "еще", "тағы", "reply", "ответить", "жауап беру", "follow", "подписаться", "жазылу",
  "verified", "author", "автор", "·", "•", "…"]);

function isNoiseToken(tok, user) {
  const low = tok.toLowerCase();
  if (!low) return true;
  if (low === user || low === "@" + user) return true;
  if (NOISE.has(low)) return true;
  if (/^[\d.,]+(k|m|тыс\.?|млн|мың)?$/i.test(low)) return true;                                  // 12, 1,2K
  if (/^\d+(s|m|h|d|w|y|с|сек|мин|м|ч|д|н|нед|г|сағ|күн|ап)\.?$/i.test(low)) return true;          // 5ч, 2h
  if (/^(s|m|h|d|w|y|с|сек|мин|м|ч|д|н|нед|г|сағ|күн|ап|тыс|млн|мың)\.?$/i.test(low)) return true; // «5 ч» ішіндегі «ч»
  if (/^\d{1,2}[./]\d{1,2}([./]\d{2,4})?$/.test(low)) return true;                                // 26.11.26
  return false;
}

export function cleanText(raw, username) {
  const user = String(username || "").toLowerCase();
  const lines = String(raw || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const kept = lines.filter((l) => {
    if (NOISE.has(l.toLowerCase())) return false;
    // Жолдың барлық сөзі «шу» болса (ник, уақыт, санауыштар, «Перевести») — алып тастаймыз
    const toks = l.split(/\s+/);
    const multi = l.toLowerCase().replace(/\s+/g, " ");
    if (NOISE.has(multi)) return false;
    return !toks.every((t) => isNoiseToken(t, user) || NOISE.has(t.toLowerCase()));
  });
  return kept.join("\n").slice(0, 3000);
}

/* ---------------- бір іздеу ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));

async function isLoginWall(page) {
  const url = page.url();
  if (/\/(login|accounts\/login|challenge|checkpoint)/i.test(url)) return true;
  return page.evaluate(() => {
    const pwd = document.querySelector('input[type="password"]');
    const hasPosts = document.querySelector('a[href*="/post/"]');
    return Boolean(pwd) && !hasPosts;
  });
}

// Кирилл әріптері үшін \w жарамайды — сондықтан \S* (бос орыннан басқа кез келген таңба)
const RECENT_RE = /^\s*(recent|latest|недавн\S*|последн\S*|новые|свеж\S*|соңғы\S*|жаңа\S*)\s*$/iu;

/** Беттегі қойынды/батырма атаулары (тек қысқа UI жазулары — жазба мәтіндері емес) */
async function uiLabels(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[role="tab"], [role="button"], a[role="link"], a[href*="search"]')) {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
      if (t && t.length <= 20 && !out.includes(t)) out.push(t);
      if (out.length >= 25) break;
    }
    return out;
  });
}

async function clickRecentTab(page) {
  // 1) role=tab, 2) кез келген қысқа мәтінді элемент — «Recent / Недавние / Последние / Соңғы»
  const candidates = [
    page.getByRole("tab", { name: RECENT_RE }),
    page.getByRole("link", { name: RECENT_RE }),
    page.getByRole("button", { name: RECENT_RE }),
    page.getByText(RECENT_RE),
  ];
  for (const loc of candidates) {
    try {
      const el = loc.first();
      if (await el.count()) {
        const label = (await el.innerText().catch(() => "")).trim();
        await el.click({ timeout: 4000 });
        await sleep(3000);
        return label || "?";
      }
    } catch (_) { /* келесісін байқаймыз */ }
  }
  return null;
}

export async function searchQuery(page, q, { scrolls = 3, top = process.env.TOP === "1" } = {}) {
  const base = `${baseUrl()}/search?q=${encodeURIComponent(q)}&serp_type=default`;
  // 1) «Үздік/Топ» (әдепкі бет): тез тарап жатқан жазбалар — лайк/пікір жинаған жағымсыз жазба осында ерте шығады
  // 2) «Соңғы»: хронологиялық тізім
  await page.goto(top ? base : base + "&filter=recent", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector('a[href*="/post/"], input[type="password"]', { timeout: 20000 }).catch(() => {});
  if (await isLoginWall(page)) return { loginRequired: true, posts: [] };
  const raw = [];
  if (top) {
    await page.mouse.wheel(0, 2500);
    await sleep(jitter(1200, 2000));
    const topRaw = await page.evaluate(extractPostsInPage);
    const tNew = topRaw.map((r) => r.timestamp).filter(Boolean).sort().pop() || "—";
    console.log(`  «Үздік»: ${topRaw.length} жазба, ең жаңасы: ${tNew}`);
    raw.push(...topRaw);
  }
  const recent = await clickRecentTab(page);
  if (!recent) {
    console.log(`  «Соңғы» қойындысы табылмады. Беттегі батырмалар: ${JSON.stringify(await uiLabels(page))}`);
    if (top) {                                    // сілтемедегі filter=recent арқылы қайта байқаймыз
      await page.goto(base + "&filter=recent", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('a[href*="/post/"]', { timeout: 20000 }).catch(() => {});
    }
  } else console.log(`  «${recent}» қойындысы таңдалды`);
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, 2500);
    await sleep(jitter(1200, 2200));
  }
  const seenCodes = new Set(raw.map((r) => r.code));
  for (const r of await page.evaluate(extractPostsInPage)) if (!seenCodes.has(r.code)) { seenCodes.add(r.code); raw.push(r); }
  const posts = raw.map((r) => ({
    id: "web:" + r.code,
    username: r.username,
    text: cleanText(r.rawText, r.username),
    timestamp: r.timestamp,
    permalink: `https://www.threads.com/@${r.username}/post/${r.code}`,
    query: q,
  })).filter((p) => p.text);
  const newest = posts.map((p) => p.timestamp).filter(Boolean).sort().pop() || "—";
  console.log(`  ең жаңа жазба уақыты: ${newest}`);
  return { loginRequired: false, posts };
}

/* ---------------- «Подписки» лентасы ---------------- */
// Жазылған аккаунттардың жаңа жазбалары лентада БІРДЕН көрінеді (іздеу индексін күтпейді).
const FOLLOWING_RE = /^\s*(following|подписки|жазылымдар|жазылулар|жазылғандар)\s*$/iu;
// Лентадағы мыңдаған жазбаның ішінен ҚазҰУ-ға қатыстыларын ғана ботқа жібереміз (дәл сүзгі — Cloudflare-де)
const FEED_STEMS = ["казну", "казгу", "қазұу", "қазну", "қазму", "kaznu", "kazgu", "фараби",
  "ұлттық университет", "национальный университет", "national university"];
export const feedRelevant = (t) => { const low = String(t || "").toLowerCase(); return FEED_STEMS.some((x) => low.includes(x)); };

const FORYOU_RE = /^\s*(for you|для вас|сіз үшін|сізге)\s*$/iu;

/** Көрінетін (жасырын емес) бірінші элементті басу */
async function clickVisible(page, re) {
  for (const loc of [page.getByRole("tab", { name: re }), page.getByRole("menuitem", { name: re }),
    page.getByRole("link", { name: re }), page.getByRole("button", { name: re }), page.getByText(re)]) {
    const n = Math.min(await loc.count().catch(() => 0), 6);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      try {
        if (!(await el.isVisible())) continue;
        await el.click({ timeout: 4000 });
        await sleep(2500);
        return true;
      } catch (_) { /* келесісі */ }
    }
  }
  return false;
}

export async function readFollowingFeed(page, { minutes = 25, maxScrolls = 15 } = {}) {
  let how = null;
  const saved = process.env.FEED_URL;                     // табылған мекенжай (міндетті емес)
  await page.goto(saved || `${baseUrl()}/following`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector('a[href*="/post/"], input[type="password"]', { timeout: 15000 }).catch(() => {});
  if (await isLoginWall(page)) return { loginRequired: true, posts: [] };
  const landed = new URL(page.url()).pathname;
  if (landed !== "/" && await page.locator('a[href*="/post/"]').count()) how = landed;
  else if (landed === "/following") {
    // Бет бар, бірақ жазба жоқ — аккаунт әлі ешкімге жазылмаған (немесе олар соңғы кезде жазбаған)
    console.log("  «Подписки» лентасы бос — скрапер аккаунты ҚазҰУ туралы жазатындарға жазылуы керек (/authors)");
    return { loginRequired: false, posts: [], found: true };
  }
  if (!how) {
    if (landed !== "/") {
      await page.goto(`${baseUrl()}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('a[href*="/post/"]', { timeout: 20000 }).catch(() => {});
    }
    if (await clickVisible(page, FOLLOWING_RE)) how = "батырма";
    else if (await clickVisible(page, FORYOU_RE) && await clickVisible(page, FOLLOWING_RE)) how = "мәзір";
    if (how) {
      await page.waitForSelector('a[href*="/post/"]', { timeout: 15000 }).catch(() => {});
      console.log(`  «Подписки» ашылды (${how}), мекенжайы: ${new URL(page.url()).pathname}${new URL(page.url()).search}`);
    }
  }
  if (!how) {
    console.log(`  «Подписки» лентасы табылмады (${landed}). Беттегі батырмалар: ${JSON.stringify(await uiLabels(page))}`);
    return { loginRequired: false, posts: [], found: false };
  }
  // Алдыңғы тексеруден бергі барлық жазбаны көру үшін — соңғы {minutes} минуттан ескі жазбаға жеткенше айналдырамыз
  const limit = Date.now() - minutes * 60 * 1000;
  let raw = [];
  for (let i = 0; i <= maxScrolls; i++) {
    raw = await page.evaluate(extractPostsInPage);
    const times = raw.map((r) => Date.parse(r.timestamp)).filter((x) => !Number.isNaN(x));
    if (times.length && Math.min(...times) < limit) break;
    await page.mouse.wheel(0, 3000);
    await sleep(jitter(1200, 2000));
  }
  const times = raw.map((r) => r.timestamp).filter(Boolean).sort();
  const posts = raw.map((r) => ({
    id: "web:" + r.code, username: r.username, text: cleanText(r.rawText, r.username), timestamp: r.timestamp,
    permalink: `https://www.threads.com/@${r.username}/post/${r.code}`, query: "Подписки",
  })).filter((p) => p.text && feedRelevant(p.text + " " + p.username));
  console.log(`  «Подписки» (${how}): ${raw.length} жазба оқылды, ${times[0] || "—"} … ${times.at(-1) || "—"}; ҚазҰУ-ға қатысты: ${posts.length}`);
  return { loginRequired: false, posts, found: true };
}

/* ---------------- негізгі ---------------- */
async function postIngest(body) {
  const url = process.env.INGEST_URL, key = process.env.INGEST_KEY;
  if (!url || !key) { console.log("⚠️ INGEST_URL / INGEST_KEY жоқ — нәтиже жіберілмейді"); return; }
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", "X-Ingest-Key": key }, body: JSON.stringify(body),
  });
  const t = await r.text();
  console.log(`Ботқа жіберілді: HTTP ${r.status} ${t.slice(0, 120)}`);
  if (r.status === 403) throw new Error("INGEST_KEY қате (403). /setup бетіндегі кілтті қайта көшіріңіз.");
}

export async function main() {
  const queries = (process.env.QUERIES ? process.env.QUERIES.split(",") : DEFAULT_QUERIES).map((s) => s.trim()).filter(Boolean);
  const cookies = parseCookies(process.env.THREADS_COOKIES || "");
  console.log(`Сұраулар: ${queries.length}, cookies: ${cookies.length}`);
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext({
    locale: "ru-RU", timezoneId: "Asia/Almaty", viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  if (cookies.length) await context.addCookies(cookies);
  const page = await context.newPage();
  const all = new Map();
  let status = "ok", message = "";
  try {
    if (process.env.FEED !== "0") {                 // алдымен ең жылдам жол — «Подписки» лентасы
      const res = await readFollowingFeed(page);
      if (res.loginRequired) { status = "login_required"; message = "login wall on feed"; }
      for (const p of res.posts) all.set(p.id, p);
      await sleep(jitter(2000, 4000));
    }
    for (const q of status === "ok" ? queries : []) {
      const res = await searchQuery(page, q);
      if (res.loginRequired) { status = "login_required"; message = `login wall on "${q}"`; break; }
      for (const p of res.posts) if (!all.has(p.id)) all.set(p.id, p);
      console.log(`«${q}»: ${res.posts.length} жазба`);       // мәтін мен никтер жария логқа жазылмайды
      await sleep(jitter(3000, 7000));
    }
    if (status === "ok" && all.size === 0) message = "no posts found (page layout may have changed)";
  } catch (e) {
    status = "error"; message = String(e && e.message || e).slice(0, 300);
    console.log("Қате:", message);
  } finally {
    await browser.close();
  }
  await postIngest({ status, message, posts: [...all.values()] });
  if (status === "login_required") console.log("❌ Аккаунтқа кіру керек: THREADS_COOKIES жаңартыңыз");
  return { status, count: all.size };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((r) => { console.log(`Дайын: ${r.status}, ${r.count} жазба`); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
