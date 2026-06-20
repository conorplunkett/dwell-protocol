#!/usr/bin/env node
// Generate audience-specific landing pages from index.html.
//
// index.html is the single source of truth: it stays the homepage (the
// developer / Claude Code default) and also acts as the template for every
// other lander. This script clones it and swaps only the *header* copy — the
// <title>, social/meta tags, the hero <h1>, the .sub line, the .hero-note, and
// the .jump CTA label — plus, when given, the before/after demo's "Stock <tool>"
// card so the page mimics the real thinking indicator of the tool that audience
// uses (e.g. ChatGPT's pulsing dot instead of Claude's asterisk). Everything
// else (advertiser form, install card, script.js) is untouched, so structural
// edits to index.html propagate to every lander on the next `make landers`.
//
// Output is a real static .html file per audience. vercel.json already sets
// `cleanUrls: true`, so `students.html` is served at `/students` — each ad
// campaign gets its own crawlable URL with the right message, present even with
// JavaScript disabled.
//
// Per-tool demo indicators are styled in landers.css (linked into each lander,
// not into index.html). Only audiences whose AI tool is actually supported by
// the product today — ChatGPT, Claude, Gemini (browser) and Claude Code — are
// generated here; Cursor / Copilot / Perplexity wait until those integrations
// ship so a live lander never promises something we can't yet deliver.
//
// No third-party deps. Run `node tools/gen-landers.mjs` or `make landers`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "index.html"), "utf8");

// Reusable "Stock <tool>" demo cards. `label` is the card's eyebrow; `icon` is
// the markup that replaces the default spinning coral asterisk. The classes map
// to indicators in landers.css. Claude is the index.html default, so a lander
// that wants the Claude look simply omits `demo`.
const DEMO = {
  chatgpt: { label: "Stock ChatGPT", icon: '<span class="think think-gpt"></span>' },
  gemini: { label: "Stock Gemini", icon: '<span class="think think-gemini"></span>' },
  claude: { label: "Stock Claude", icon: '<span class="ast">✳</span>' },
};

// Each lander overrides the header copy (and optionally the demo) for one
// audience. `slug` is the output file and, via cleanUrls, the URL path.
const LANDERS = [
  {
    slug: "developers",
    title: "FreeAI.fyi — Get Claude for free while you ship code",
    description:
      "Earn Claude credits while you build with Claude Code, ChatGPT and Gemini. A subtle sponsored line shows while the model thinks — 50% of the revenue comes back to you as credits for Claude.",
    ogTitle: "FreeAI.fyi — Get Claude for free while you ship code",
    ogDescription:
      "50% of the revenue comes back as Claude credits. Bid live for the most-watched spinner on Earth.",
    h1: "Make money while you build.",
    sub:
      "We turned “Discombobulating…” into an ad marketplace. " +
      "<strong>50%</strong> of the revenue comes back to you as " +
      "<span class=\"hl\">Claude monthly plans</span>, reducing your and your friends’ AI spend to $0.",
    heroNote:
      "Works inside <strong>Claude Code, ChatGPT &amp; Gemini</strong> while you build. A subtle " +
      "sponsored line appears while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
    // Claude look is the index.html default — no demo override needed.
  },
  {
    slug: "chatgpt",
    title: "FreeAI.fyi — Earn Claude credits while you use ChatGPT",
    description:
      "Already chatting with ChatGPT? A subtle sponsored line shows while it thinks, and 50% of the revenue comes back to you as free Claude credits. Free Chrome extension.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you use ChatGPT",
    ogDescription:
      "Get paid to use the AI you already use. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid to use ChatGPT.",
    sub:
      "We turned “Thinking…” into an ad marketplace. While <strong>ChatGPT</strong> " +
      "answers, one subtle sponsored line appears — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>, reducing your AI spend to $0.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser. A subtle " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
    demo: DEMO.chatgpt,
  },
  {
    slug: "gemini",
    title: "FreeAI.fyi — Earn Claude credits while you use Gemini",
    description:
      "Use Gemini for work or school? A subtle sponsored line shows while it thinks, and 50% of the revenue comes back to you as free Claude credits. Free Chrome extension.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you use Gemini",
    ogDescription:
      "Get paid to use Gemini. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid to use Gemini.",
    sub:
      "We turned “Thinking…” into an ad marketplace. While <strong>Gemini</strong> " +
      "answers, one subtle sponsored line appears — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>, reducing your AI spend to $0.",
    heroNote:
      "Works inside <strong>Gemini, ChatGPT &amp; Claude</strong> in your browser. A subtle " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
    demo: DEMO.gemini,
  },
  {
    slug: "students",
    title: "FreeAI.fyi — Free AI for students",
    description:
      "Cut your AI spend to $0. Earn Claude credits while you use ChatGPT, Claude and Gemini for class — a subtle sponsored line shows while the AI thinks and 50% comes back to you.",
    ogTitle: "FreeAI.fyi — Free AI for students",
    ogDescription:
      "Stop paying for AI. 50% of the revenue comes back to you as Claude credits — share it with your class.",
    h1: "Free AI for students.",
    sub:
      "Stop paying for AI. A subtle sponsored line shows while <strong>ChatGPT, Claude &amp; " +
      "Gemini</strong> think — and <strong>50%</strong> of the revenue comes back to you as " +
      "<span class=\"hl\">Claude credits</span>, reducing your and your classmates’ AI spend to $0.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser — free to install. " +
      "A subtle sponsored line appears while the model thinks, and <strong>50%</strong> of what it " +
      "earns becomes credits you redeem for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
    demo: DEMO.chatgpt,
  },
  {
    slug: "writers",
    title: "FreeAI.fyi — Earn Claude credits while you write with AI",
    description:
      "Draft, edit and brainstorm with ChatGPT, Claude and Gemini — and earn free Claude credits while you do. A subtle sponsored line shows while the AI thinks; 50% comes back to you.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you write with AI",
    ogDescription:
      "Get paid for the AI you already write with. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid while you write.",
    sub:
      "Every draft, rewrite and outline you run through <strong>ChatGPT, Claude &amp; Gemini</strong> " +
      "shows one subtle sponsored line while it thinks — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser. A subtle " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
    demo: DEMO.chatgpt,
  },
  {
    slug: "researchers",
    title: "FreeAI.fyi — Earn Claude credits while you research with AI",
    description:
      "Run questions through Gemini, ChatGPT and Claude all day? A subtle sponsored line shows while they think, and 50% of the revenue comes back to you as Claude credits.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you research with AI",
    ogDescription:
      "Turn your AI research habit into Claude credits. 50% of the revenue comes back to you.",
    h1: "Get paid while you research.",
    sub:
      "Every question you run through <strong>Gemini, ChatGPT &amp; Claude</strong> shows one subtle " +
      "sponsored line while it thinks — and <strong>50%</strong> of the revenue comes back to you as " +
      "<span class=\"hl\">Claude credits</span>, cutting your research stack to $0.",
    heroNote:
      "Works inside <strong>Gemini, ChatGPT &amp; Claude</strong> in your browser. A subtle " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
    demo: DEMO.gemini,
  },
  {
    slug: "founders",
    title: "FreeAI.fyi — Cut your startup's AI bill to $0",
    description:
      "Your team runs on Claude, ChatGPT and Gemini. A subtle sponsored line shows while they think, and 50% of the revenue comes back as Claude credits — turning AI spend into runway.",
    ogTitle: "FreeAI.fyi — Cut your startup's AI bill to $0",
    ogDescription:
      "Turn your team's AI spend into runway. 50% of the revenue comes back as Claude credits.",
    h1: "Turn AI spend into runway.",
    sub:
      "Your team already runs on <strong>Claude, ChatGPT &amp; Gemini</strong>. A subtle sponsored " +
      "line shows while they think — and <strong>50%</strong> of the revenue comes back as " +
      "<span class=\"hl\">Claude credits</span>, turning AI spend into runway.",
    heroNote:
      "Works inside <strong>Claude, ChatGPT &amp; Gemini</strong> in your browser. A subtle " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits your team redeems for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
    demo: DEMO.claude,
  },
  {
    slug: "marketers",
    title: "FreeAI.fyi — Earn Claude credits while you make content with AI",
    description:
      "Generate campaigns, captions and briefs with ChatGPT, Claude and Gemini — and earn free Claude credits while you do. A subtle sponsored line shows while the AI thinks; 50% comes back.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you make content with AI",
    ogDescription:
      "Get paid for every AI prompt. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid for every prompt.",
    sub:
      "Every campaign, caption and brief you generate with <strong>ChatGPT, Claude &amp; Gemini</strong> " +
      "shows one subtle sponsored line while it thinks — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser. A subtle " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
    demo: DEMO.chatgpt,
  },
  {
    slug: "advertisers",
    title: "FreeAI.fyi — Advertise on the most-watched spinner on Earth",
    description:
      "Bid live for the sponsored line that shows while ChatGPT, Claude and Gemini think. Each block buys 1,000 five-second impressions; clicks bill at 50×. Start from $0.50.",
    ogTitle: "FreeAI.fyi — Advertise on the most-watched spinner on Earth",
    ogDescription:
      "Bid live for the most-watched spinner on Earth. Each block buys 1,000 impressions; start from $0.50.",
    h1: "Bid on the most-watched spinner on Earth.",
    sub:
      "Your line shows while <strong>ChatGPT, Claude &amp; Gemini</strong> think — the one moment " +
      "every AI user stares at the screen. Bid live from <strong>$0.50</strong>, " +
      "<span class=\"hl\">pay only for attention</span>, and 50% of every dollar becomes Claude " +
      "credits for the user who showed your ad.",
    heroNote:
      "Each block buys <strong>1,000</strong> five-second impressions while ChatGPT, Claude &amp; " +
      "Gemini think. Clicks bill at <strong>50×</strong>. Highest bid serves first — outbid the top " +
      "to take #1.",
    jump: "JUMP TO THE BID FORM ↓",
  },
];

// Replace the first match of `re` in `html`, or fail loudly so a copy/markup
// change to index.html can never silently produce a stale lander.
function sub(html, label, re, value) {
  if (!re.test(html)) {
    throw new Error(`gen-landers: anchor not found in index.html: ${label}`);
  }
  return html.replace(re, value);
}

let written = 0;
for (const l of LANDERS) {
  let out = src;

  // Link the lander-only stylesheet (per-tool demo indicators) right after the
  // shared styles.css, so its classes resolve without touching index.html.
  out = sub(
    out,
    "styles.css link",
    /(<link rel="stylesheet" href="styles\.css\?v=[^"]*" \/>)/,
    `$1\n  <link rel="stylesheet" href="landers.css?v=20260620a" />`,
  );

  out = sub(out, "title", /<title>[\s\S]*?<\/title>/, `<title>${l.title}</title>`);
  out = sub(
    out,
    "meta description",
    /<meta name="description" content="[\s\S]*?" \/>/,
    `<meta name="description" content="${l.description}" />`,
  );
  out = sub(
    out,
    "og:title",
    /<meta property="og:title" content="[\s\S]*?" \/>/,
    `<meta property="og:title" content="${l.ogTitle}" />`,
  );
  out = sub(
    out,
    "og:description",
    /<meta property="og:description" content="[\s\S]*?" \/>/,
    `<meta property="og:description" content="${l.ogDescription}" />`,
  );
  out = sub(out, "hero h1", /<h1>[\s\S]*?<\/h1>/, `<h1>${l.h1}</h1>`);
  out = sub(
    out,
    "hero .sub",
    /<p class="sub">[\s\S]*?<\/p>/,
    `<p class="sub">\n        ${l.sub}\n      </p>`,
  );
  out = sub(
    out,
    "hero .hero-note",
    /<p class="hero-note">[\s\S]*?<\/p>/,
    `<p class="hero-note">\n        ${l.heroNote}\n      </p>`,
  );
  // The .jump link keeps its dot + chevron; only the middle label text changes.
  out = sub(
    out,
    ".jump label",
    /(<a href="#advertisers" class="jump">\s*<span class="jump-dot"><\/span>)[\s\S]*?(<div class="jump-chev">)/,
    `$1 ${l.jump}\n        $2`,
  );

  // Optional: make the "Stock <tool>" demo card mimic this audience's tool.
  if (l.demo) {
    out = sub(
      out,
      "demo-label",
      /<span class="demo-label">Stock Claude<\/span>/,
      `<span class="demo-label">${l.demo.label}</span>`,
    );
    out = sub(out, "demo think-icon", /<span class="ast">✳<\/span>/, l.demo.icon);
  }

  // Mark which lander rendered, for debugging and analytics segmentation.
  out = out.replace(/<body>/, `<body data-lander="${l.slug}">`);

  writeFileSync(join(root, `${l.slug}.html`), out);
  written++;
  console.log(`  wrote ${l.slug}.html`);
}

console.log(`gen-landers: generated ${written} landing page(s) from index.html`);
