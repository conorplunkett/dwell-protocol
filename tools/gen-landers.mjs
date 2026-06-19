#!/usr/bin/env node
// Generate audience-specific landing pages from index.html.
//
// index.html is the single source of truth: it stays the homepage (the
// developer / Claude Code default) and also acts as the template for every
// other lander. This script clones it and swaps only the *header* copy — the
// <title>, social/meta tags, the hero <h1>, the .sub line, the .hero-note, and
// the .jump CTA label — leaving the rest of the page (demo, advertiser form,
// styles, script.js) untouched, so structural edits to index.html propagate to
// every lander on the next `make landers`.
//
// Output is a real static .html file per audience. vercel.json already sets
// `cleanUrls: true`, so `students.html` is served at `/students` — each ad
// campaign gets its own crawlable URL with the right message, and the copy is
// present even with JavaScript disabled.
//
// No third-party deps. Run `node tools/gen-landers.mjs` or `make landers`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "index.html"), "utf8");

// Each lander overrides the header copy for one audience. `slug` is the output
// file (and, via cleanUrls, the URL path). Keep copy ASCII-safe punctuation
// aside from the curly quotes/dashes already used on the page.
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
  },
  {
    slug: "chatgpt",
    title: "FreeAI.fyi — Earn Claude credits while you use ChatGPT & Gemini",
    description:
      "Already chatting with ChatGPT or Gemini? A subtle sponsored line shows while the AI thinks, and 50% of the revenue comes back to you as free Claude credits. Free Chrome extension.",
    ogTitle: "FreeAI.fyi — Earn Claude credits while you use ChatGPT & Gemini",
    ogDescription:
      "Get paid to use the AI you already use. 50% of the revenue comes back as Claude credits.",
    h1: "Get paid to use ChatGPT.",
    sub:
      "We turned “Thinking…” into an ad marketplace. While <strong>ChatGPT &amp; Gemini</strong> " +
      "answer, one subtle sponsored line appears — and <strong>50%</strong> of the revenue comes " +
      "back to you as <span class=\"hl\">free Claude credits</span>, reducing your AI spend to $0.",
    heroNote:
      "Works inside <strong>ChatGPT, Claude &amp; Gemini</strong> in your browser. A subtle " +
      "sponsored line appears only while the model thinks — and <strong>50%</strong> of what it earns " +
      "becomes credits you redeem for Claude Pro or Max.",
    jump: "FOR ADVERTISERS · BID ON THIS LINE",
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

  // Mark which lander rendered, for debugging and analytics segmentation.
  out = out.replace(/<body>/, `<body data-lander="${l.slug}">`);

  writeFileSync(join(root, `${l.slug}.html`), out);
  written++;
  console.log(`  wrote ${l.slug}.html`);
}

console.log(`gen-landers: generated ${written} landing page(s) from index.html`);
