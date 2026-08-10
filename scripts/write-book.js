#!/usr/bin/env node
/**
 * SGSS Daily Book Writer — runs in GitHub Actions.
 *
 * Every day (per repo, per config) this script:
 *   1. Reads the book's current content (book.md / book.html / index.html)
 *   2. Calls opencode.ai (big-pickle) with full book context + instructions
 *      from book.config.json and asks for the NEXT ~2,000 words
 *   3. Appends the new chapter(s) to the markdown source
 *   4. Injects the same content into the styled HTML page(s)
 *   5. Commits + pushes → GitHub Pages auto-rebuilds → book grows daily
 *
 * Running from GitHub runners keeps opencode.ai from flagging any IP
 * (fresh runner IPs, once per day per repo).
 *
 * Exit codes: 0 = ok (content written or nothing to do), 1 = failure.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Config ─────────────────────────────────────────────────────────────────
const CONFIG_PATH = "book.config.json";
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const TITLE = cfg.title || "Untitled";
const TARGET_WORDS = cfg.targetWords || 2000;
const API_TIMEOUT_MS = cfg.apiTimeoutMs || 600000; // 10 min for 2k words
const MAX_TOKENS = cfg.maxTokens || 16384;
const MAX_TRIES = 6;

const BASE_URL = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1";
const MODEL = process.env.MODEL || "big-pickle";

// Primary key + fallbacks (same design as openclaw.json's big-pickel1..4)
const KEYS = [process.env.OPENCODE_API_KEY, process.env.OPENCODE_API_KEY_2, process.env.OPENCODE_API_KEY_3, process.env.OPENCODE_API_KEY_4, process.env.OPENCODE_API_KEY_5]
  .filter(Boolean);
if (!KEYS.length) {
  console.error("❌ OPENCODE_API_KEY not set");
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function log(...a) { console.log("[writer]", ...a); }

function readFile(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

// HTML-escape for text placed into HTML body
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Style detection (each book has a slightly different HTML convention) ──
function detectHtmlStyle(html) {
  const has = (re) => re.test(html);
  if (has(/class="chapter-intro"/)) return "chapter-intro";     // elon-musk style
  if (has(/class="chapter-header"/)) return "chapter-header";   // museveni style
  if (has(/class="chapter"/)) return "chapter-div";             // novel/tv companion style
  return "bare-h2";                                             // atlas-of-feeling style
}

// Convert a single markdown chapter (## heading + paragraphs) to HTML.
// Keeps the chapter's own heading level so novels' "### Chapter N" stays a subheading.
function mdChunkToHtml(md, style) {
  const lines = md.split("\n");
  const out = [];
  let heading = null;
  const paras = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (heading || paras.length) {
        out.push(renderSection(heading, paras, style));
        heading = null; paras.length = 0;
      }
      heading = { level: h[1].length, text: h[2] };
      continue;
    }
    paras.push(raw.trim());
  }
  if (heading || paras.length) out.push(renderSection(heading, paras, style));
  return out.join("\n");
}

function renderSection(heading, paras, style) {
  let html = "";
  let wrapped = false;
  const text = heading ? heading.text : "";
  if (heading) {
    const isPart = /^Part\b/i.test(text);
    if (isPart && style === "chapter-div") {
      html += `<div class="part-title">${esc(text)}</div>\n`;
    } else {
      const lvl = Math.min(3, heading.level + 1); // md ## -> h3 inside chapter div
      if (style === "chapter-div") {
        html += `<div class="chapter">\n<h${lvl}>${esc(text)}</h${lvl}>\n`;
        wrapped = true;
      } else if (style === "chapter-intro") {
        html += `<div class="chapter-intro">\n<h2>${esc(text)}</h2>\n`;
        wrapped = true;
      } else if (style === "chapter-header") {
        html += `<div class="chapter" >\n<div class="chapter-header">\n<div class="chapter-title">${esc(text)}</div>\n</div>\n`;
        wrapped = true;
      } else {
        html += `<h2>${esc(text)}</h2>\n`;
      }
    }
  }
  for (const p of paras) {
    if (!p) continue;
    if (p.startsWith("---")) { html += "<hr>\n"; continue; }
    if (/^\*\*.*\*\*$/.test(p)) { html += `<p><strong>${esc(p.replace(/^\*\*|\*\*$/g, ""))}</strong></p>\n`; continue; }
    if (/^_/i.test(p) || /_\s*$/i.test(p)) { html += `<p><em>${esc(p.replace(/^_+|_+$/g, ""))}</em></p>\n`; continue; }
    html += `<p>${esc(p)}</p>\n`;
  }
  if (wrapped) html += "</div>\n";
  return html;
}

// ── Markdown helpers ───────────────────────────────────────────────────────
function findInsertPoint(md) {
  // Story content ends at the first of: a trailing "— End —" marker,
  // "## About This Book" / "## About the Book", or a trailing "---\n\n**Author:" block.
  // Otherwise: EOF. New content is inserted BEFORE the marker so the
  // marker stays the true ending of the book.
  const endMarker = md.search(/^\*?—\s*End\s*—\*?\s*$/m);
  if (endMarker >= 0) return endMarker;
  let idx = -1;
  const m = md.match(/^##\s+About (This Book|the Book)/m);
  if (m) idx = m.index;
  else {
    const m2 = md.match(/\n---\n\n\*\*Author:/);
    if (m2) idx = m2.index;
  }
  return idx >= 0 ? idx : md.length;
}

function updateMd(md, newChaptersMd, headingLevel) {
  let insert = findInsertPoint(md);
  let head = md.slice(0, insert).replace(/[\s]*$/, "\n\n");
  // strip any trailing "---" separator right before the About block
  if (/---\s*$/.test(head)) head = head.replace(/---\s*$/, "").replace(/[\s]*$/, "\n\n");

  // Normalize chapter headings in new content to the configured level.
  // Part headings stay at level 2 (matches the novels' structure).
  let body = newChaptersMd
    .split("\n")
    .map((line) => {
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (!h) return line;
      const text = h[2];
      if (/^Part\b/i.test(text)) return `## ${text}`;
      return `${"#".repeat(Math.max(2, headingLevel || 2))} ${text}`;
    })
    .join("\n")
    .trim();

  const tail = md.slice(insert);
  return head + body + "\n\n---\n\n" + tail.replace(/^[\s]*/, "");
}

// ── HTML injection helpers ─────────────────────────────────────────────────
function findHtmlInsertPoint(html) {
  // 1) explicit end marker: <p ...>— End —</p> — insert BEFORE it
  let m = html.match(/<p[^>]*>—\s*End\s*—<\/p>/i);
  if (m) return m.index;
  // 2) "The End" paragraph — insert BEFORE it
  m = html.match(/<p[^>]*class="the-end"[^>]*>.*?<\/p>/i);
  if (m) return m.index;
  // 3) "— ◆ —" end mark — insert BEFORE it
  m = html.match(/<div class="end-mark">.*?<\/div>/i);
  if (m) return m.index;
  // 4) about/footer blocks
  m = html.match(/<div class="about">/i);
  if (m) return m.index;
  m = html.match(/<div class="content-warning">/i);
  if (m) return m.index;
  m = html.match(/<div class="support-box">/i);
  if (m) return m.index;
  m = html.match(/<div class="footer">/i);
  if (m) return m.index;
  // 5) closing tags
  m = html.match(/<\/div>\s*<\/body>/i);
  if (m) return m.index;
  m = html.match(/<\/body>/i);
  if (m) return m.index;
  return html.length;
}

function injectIntoHtml(html, chunkHtml, style) {
  const idx = findHtmlInsertPoint(html);
  const before = html.slice(0, idx).replace(/[\s]*$/, "\n\n");
  const after = html.slice(idx).replace(/^[\s]*/, "");
  let insert = chunkHtml.trim();
  if (style !== "chapter-div" && style !== "chapter-header" && style !== "chapter-intro") {
    // bare-h2: wrap sections in a container so they inherit page styles
    insert = `<div class="book-section">\n${insert}\n</div>`;
  }
  return before + insert + "\n\n" + after;
}

// Dialogues-with-my-love: inject into index.html (TOC + content before Fin)
function updateDialoguesIndex(indexHtml, md) {
  const chapters = [];
  const re = /^##\s+(.+)$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    const t = m[1].trim();
    if (/^Part\b/i.test(t) || /^About\b/i.test(t)) continue;
    chapters.push(t);
  }
  const toc = chapters
    .map((t) => {
      const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return `<div class="toc-h2"><a href="#${slug}">${esc(t)}</a></div>`;
    })
    .join("\n");

  // Build the injected section html
  const bodyHtml = md
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const slug = h[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return `<h${Math.min(3, h[1].length + 1)} id="${slug}">${esc(h[2])}</h${Math.min(3, h[1].length + 1)}>`;
      }
      if (line === "---") return "<hr>";
      return `<p>${esc(line)}</p>`;
    })
    .join("\n");

  const section = `<section id="read-online">
  <h2>Read Online — The Complete Book</h2>
  <div class="toc"><h2>📑 Table of Contents</h2>
${toc}
</div>

  <div class="book-content">
${bodyHtml}
  </div>
</section>`;

  // Replace existing injected section if present, else insert before Fin
  const startTag = '<section id="read-online">';
  const endTag = "</section>";
  const s = indexHtml.indexOf(startTag);
  if (s >= 0) {
    const e = indexHtml.indexOf(endTag, s);
    if (e >= 0) {
      return indexHtml.slice(0, s) + section + indexHtml.slice(e + endTag.length);
    }
  }
  const fin = indexHtml.match(/<p><em>Fin\.<\/em><\/p>/i);
  const idx = fin ? fin.index : indexHtml.length;
  return indexHtml.slice(0, idx) + section + "\n\n" + indexHtml.slice(idx);
}

// ── API call ───────────────────────────────────────────────────────────────
async function generateNext(bookCtx, lastWords, prompt, maxTokens, keyIndex) {
  const API_KEY = KEYS[keyIndex % KEYS.length];
  const sys = `You are ${TITLE}, the continuing author of the book "${TITLE}" by ${cfg.author || "Walusimbi Leon (SGSS)"}.\n` +
    `Write in the established voice and style. Continue the story/content exactly where it left off — no recaps, no filler, no "In this chapter...".\n` +
    `Stay consistent with characters, timeline, tone, and already-established facts. Do not repeat or contradict earlier content.\n` +
    `Prose must be vivid, specific, and publication-quality. Around ${TARGET_WORDS} words in a single new chapter (or one coherent section).\n` +
    `Write ONLY the new content — no commentary, no summaries, no notes.`;

  const user =
    `BOOK: ${cfg.description || ""}\n\n` +
    (cfg.genre ? `GENRE: ${cfg.genre}\n\n` : "") +
    (cfg.style ? `STYLE: ${cfg.style}\n\n` : "") +
    (cfg.characters ? `CHARACTERS: ${cfg.characters}\n\n` : "") +
    (cfg.setting ? `SETTING: ${cfg.setting}\n\n` : "") +
    (cfg.notes ? `DIRECTIONS: ${cfg.notes}\n\n` : "") +
    `FORMAT RULES:\n${prompt}\n\n` +
    `--- LAST ~1,200 WORDS OF THE BOOK SO FAR (continue from here) ---\n${lastWords}\n`;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0.85,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (res.status === 429) throw new Error("rate limited");
  if (!res.ok) throw new Error(`opencode.ai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content || "";
  if (!content.trim()) throw new Error("empty content from model");
  // Strip possible reasoning block if the model leaks one
  content = content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  return content;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const mdFiles = cfg.mdFiles || [];
  const htmlFiles = cfg.htmlFiles || [];
  const indexInject = cfg.indexInject; // optional index.html path (dialogues)
  const headingLevel = cfg.mdHeadingLevel || 2;

  if (!mdFiles.length && !htmlFiles.length) {
    throw new Error("config has no mdFiles or htmlFiles");
  }

  // Load story source: prefer md, else first html
  let storySrc = "";
  let storyPath = null;
  for (const f of mdFiles) {
    const c = readFile(f);
    if (c) { storySrc = c; storyPath = f; break; }
  }
  if (!storySrc && htmlFiles.length) {
    storySrc = stripHtml(readFile(htmlFiles[0]) || "");
    storyPath = htmlFiles[0];
  }
  if (!storySrc) throw new Error("no book content found");
  log(`story source: ${storyPath} (${wordCount(storySrc)} words)`);

  // Next chapter number (only if the config wants numbered chapters)
  const mdHead = mdFiles.map(readFile).find(Boolean) || storySrc;
  const chapterRe = /(?:^|\n)#{2,4}\s+(?:Chapter|CHAPTER)\s+([0-9]+)/g;
  let maxN = 0;
  let m;
  while ((m = chapterRe.exec(mdHead)) !== null) maxN = Math.max(maxN, parseInt(m[1], 10));
  const nextN = maxN + 1;

  // Chapter title prompt
  const chapterTitle = cfg.chapterTitle || "Chapter";
  const chapterPrompt = maxN > 0
    ? (cfg.chapterPrompt || `Start with "## ${chapterTitle} ${nextN} — <Title>" (or "## Part X — <Name>" first if a new part begins). Then write the chapter body as prose paragraphs.`)
    : `Start with a "## <Chapter Title>" heading that continues the book naturally (the next chapter or section). Do not repeat any existing chapter title or number. Then write the chapter body as prose paragraphs.`;

  // Tail of current content for continuity
  const lastWords = storySrc.split(/\s+/).slice(-1200).join(" ");

  // Generate — rotate through fallback keys, back off harder each try
  let content = null;
  for (let i = 1; i <= MAX_TRIES; i++) {
    const keyIdx = i - 1;
    try {
      content = await generateNext(storySrc, lastWords, chapterPrompt, MAX_TOKENS, keyIdx);
      const wc = wordCount(content.replace(/^#{1,6}\s.*$/gm, ""));
      log(`attempt ${i} (key ${keyIdx + 1}/${KEYS.length}): generated ${wc} words`);
      if (wc < 300) throw new Error(`too short (${wc} words)`);
      break;
    } catch (err) {
      log(`attempt ${i} (key ${keyIdx + 1}/${KEYS.length}) failed: ${err.message}`);
      if (i === MAX_TRIES) throw err;
      await new Promise((r) => setTimeout(r, 15000 * i * i)); // 15s, 60s, 135s, 240s…
    }
  }

  // Normalize the new content
  const newMd = content.replace(/```/g, "").trim();
  const chunkHtml = mdChunkToHtml(newMd, detectHtmlStyle(readFile(htmlFiles[0]) || ""));

  // Apply to markdown files
  let anyChange = false;
  for (const f of mdFiles) {
    const cur = readFile(f);
    if (!cur) { log(`skip md (missing): ${f}`); continue; }
    const updated = updateMd(cur, newMd, headingLevel);
    if (updated !== cur) {
      fs.writeFileSync(f, updated);
      log(`✍️  md updated: ${f}`);
      anyChange = true;
    }
  }

  // Apply to html files
  const style = detectHtmlStyle(readFile(htmlFiles[0]) || "");
  for (const f of htmlFiles) {
    const cur = readFile(f);
    if (!cur) { log(`skip html (missing): ${f}`); continue; }
    const updated = injectIntoHtml(cur, chunkHtml, style);
    if (updated !== cur) {
      fs.writeFileSync(f, updated);
      log(`✍️  html updated: ${f}`);
      anyChange = true;
    }
  }

  // Dialogues-style index injection
  if (indexInject) {
    const cur = readFile(indexInject);
    if (cur) {
      const updated = updateDialoguesIndex(cur, mdFiles.map(readFile).find(Boolean) || storySrc);
      if (updated !== cur) {
        fs.writeFileSync(indexInject, updated);
        log(`✍️  index updated: ${indexInject}`);
        anyChange = true;
      }
    }
  }

  // Mirror identical copies (root book.md/book.html when they duplicate a target)
  const mirrorTargets = [...mdFiles, ...htmlFiles];
  const oldContents = {};
  for (const t of mirrorTargets) oldContents[t] = readFile(t);
  const allFiles = fs.readdirSync(".", { recursive: true }).filter(
    (f) => /(^|\/)(book|index)\.(md|html)$/.test(f) && !f.includes("node_modules")
  );
  for (const f of allFiles) {
    if (mirrorTargets.includes(f)) continue;
    const content = readFile(f);
    if (!content) continue;
    for (const t of mirrorTargets) {
      if (content === oldContents[t]) {
        const newContent = readFile(t);
        if (newContent !== content) {
          fs.writeFileSync(f, newContent);
          log(`🪞 mirrored: ${f}`);
          anyChange = true;
        }
        break;
      }
    }
  }

  if (!anyChange) {
    log("nothing changed — already up to date");
    return;
  }

  // Commit & push
  execSync("git add -A", { stdio: "inherit" });
  const diff = execSync("git diff --cached --stat", { encoding: "utf8" });
  log(diff);
  const wcNew = wordCount(content.replace(/^#{1,6}\s.*$/gm, ""));
  execSync(
    `git -c user.name="SGSS Books Bot" -c user.email="walusimbileon3@gmail.com" commit -m "📖 Daily writing: ${TITLE} (+~${wcNew} words)"`,
    { stdio: "inherit" }
  );
  try {
    execSync("git push", { stdio: "inherit" });
    log("✅ pushed — GitHub Pages will rebuild");
  } catch (err) {
    // No remote (local test) or transient failure — fail loudly on real runs only.
    if (process.env.ALLOW_NO_PUSH !== "1") throw err;
    log("⚠️  no remote — skipped push (local test mode)");
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
