---
name: premium-web-design
description: Codeply's default visual bar for any website, landing page, or UI it generates — vanilla HTML/CSS/JS techniques (type, color, depth, scroll-triggered motion, subtle 3D) that make even a trivial brief (a tea shop, a local plumber, a one-page portfolio) read as an expensive, art-directed build instead of a templated AI scaffold. Use for every "build me a website / page / landing site" request, no matter how small the business sounds — small brief is not license for a flat result.
metadata:
  origin: codeply
---

# Premium Web Design

The gap between "a website" and "a website that looks like it cost $10k" is not
more content. It is five things done deliberately instead of by default: type,
color, depth, motion, and restraint. This skill is the checklist that turns a
plain-HTML brief — a tea shop, a barber, a two-person agency — into something
that reads as art-directed. Apply it **even when the user's request is one
sentence and sounds trivial.** The size of the brief is not license for a flat
result; a tea shop site gets the same craft pass as a SaaS landing page.

## When to Use

Any time you are about to write or restyle HTML/CSS for a page a human will
look at: landing pages, marketing sites, portfolios, small-business sites,
dashboards, docs, artifacts. If the deliverable renders in a browser and has
no explicit "keep it minimal/utilitarian" instruction from the user, this
skill applies by default — do not wait to be asked for "premium" or
"animated."

## The Five Levers

### 1. Type — pick a pairing, not a default

Never ship `system-ui` / Arial as the whole identity. Pick ONE deliberate
pairing and commit:
- Editorial: a serif display (Fraunces, Playfair Display, Instrument Serif) +
  a clean grotesk body (Inter, General Sans, Geist).
- Technical/modern: one variable grotesk (Inter, Geist, Söhne-alike) at two
  weights, huge size contrast between hero and body.
- Warm/local business (cafés, shops, studios): a humanist serif or friendly
  display headline + a quiet sans body — avoid corporate SaaS grotesk here,
  it reads generic for a tea shop.

Rules: headline sizes should feel oversized relative to instinct (clamp with
`clamp(2.5rem, 6vw, 5.5rem)`), line-height tight on display type (1.0–1.1),
loose on body (1.5–1.7), and letter-spacing slightly negative on large type
(`-0.02em` to `-0.04em`). Import via `@font-face`/Google Fonts `<link>` —
never leave it at the browser default.

### 2. Color — a system, not a palette guess

Ban: purple-to-blue gradient hero, pure `#000`/`#fff` with a single accent
blue, "AI slop" default (indigo #6366f1 / violet #8b5cf6 on white cards).
Instead build a small token system from the domain:
- 1 base neutral (often warm, not pure gray — `#f7f4ee`, `#111014`)
- 1 ink color for text (rarely pure black — try a near-black with a hue lean)
- 1–2 brand colors pulled from the actual subject (a tea shop: terracotta,
  moss, cream, not tech-blue)
- 1 accent used sparingly (links, one CTA, one highlight) — not on every card

Define them as CSS custom properties on `:root` and reuse everywhere; that
alone makes a page look designed instead of assembled.

### 3. Depth — layered, not flat-card-grid

Avoid the default "grid of identical white cards with a drop-shadow" — it is
the single most recognizable AI-generated-site tell. Instead:
- Vary section backgrounds (alternate base/ink/tinted sections) so the page
  has rhythm when you scroll, not one long white column.
- Use large background shapes, subtle grain/noise texture, or a soft radial
  glow behind hero content instead of a flat solid fill.
- Layer real photography or generated imagery behind translucent panels
  (`backdrop-filter: blur(16px)`, semi-opaque background) for a glass feel
  where it fits the brand — skip it for utilitarian dashboards.
- Give the hero one asymmetric or oversized element (an oversized product
  shot bleeding off-canvas, an angled image, a big pull-quote) instead of
  centered text + centered image every time.

**Imagery must be on-topic, not just present.** A hero image is worse than no
image if it's unrelated to the subject — a beach photo on a tea brand's
"Our Heritage" section reads as more broken than a placeholder color block,
because it actively contradicts the copy next to it. When fetching stock
imagery with `fetch_image`, use a keyword-searchable source
(`https://loremflickr.com/<w>/<h>/<keyword1>,<keyword2>`) and pick keywords
per-section from that section's actual subject — never a fully-random source
like picsum.photos on a themed site. A tea shop's hero gets `tea,leaves` or
`teapot,ceremony`, a product card for oolong gets `oolong,tea`, not one
generic keyword reused everywhere or no keyword at all. If no source can be
made reliably on-topic for a given spot (an odd or very specific subject),
prefer a solid-color/gradient placeholder panel over a wrong photo, and say
so to the user.

### 4. Motion — scroll-triggered, physical, restrained

A static page reads cheap even with good type/color. Add motion with plain
CSS/JS (no framework required):

```css
.reveal { opacity: 0; transform: translateY(24px); transition: opacity .7s cubic-bezier(.16,1,.3,1), transform .7s cubic-bezier(.16,1,.3,1); }
.reveal.is-visible { opacity: 1; transform: translateY(0); }
@media (prefers-reduced-motion: reduce) { .reveal { transition: none; opacity: 1; transform: none; } }
```

```js
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) e.target.classList.add('is-visible');
}, { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
```

Layer in: a subtle parallax on the hero image (`transform: translateY()`
tied to scroll position, small range like 20–40px), a hover tilt on cards
(`transform: perspective(800px) rotateX() rotateY()` from pointer position,
a cheap but convincing "3D" feel), and a smooth `scroll-behavior: smooth` for
anchor nav. Stagger reveal delays across siblings (`transition-delay` +
`nth-child`) instead of everything fading in at once — staggering is what
makes a section feel choreographed rather than triggered.

Always respect `prefers-reduced-motion`. Keep transitions 200–700ms;
snappy for hover/press, slower for scroll reveals.

### 5. Restraint — the difference between premium and busy

- One hero move, one card-hover move, one scroll-reveal pattern — reused
  consistently, not five different animation styles competing.
  `frontend-design-direction` has the anti-pattern list (no cards-in-cards,
  no gradient blobs, no vague hero copy) — use_skill it too on larger builds.
- Whitespace is a design choice, not leftover space: generous section
  padding (`clamp(4rem, 10vw, 8rem)` vertical), generous gaps in grids.
  Cramped sections are the second most common AI-slop tell after flat cards.
- Real, specific copy beats generic copy: name the actual product (single-
  origin oolong, not "our amazing products"), and if there's no CMS/content
  yet, write copy that sounds like this specific business, not a template.

## Quick Pre-Ship Checklist

- Is there a real font pairing, or did I leave system defaults?
- Is the palette pulled from the subject, or is it default-AI indigo/violet?
- Does the hero have one asymmetric/oversized visual idea, or is everything
  centered and evenly sized?
- Does anything move on scroll or hover, or is the page fully static?
- Are sections visually differentiated (background/rhythm), or one flat
  white column of same-size cards?
- Would this specific business (a tea shop, not "a company") recognize
  itself in the copy and color choices?

If any answer is "no," the build is not done — go back and apply the lever
before calling it finished.

## Related Skills

- `frontend-design-direction` — direction-setting discipline (purpose,
  audience, tone, anti-patterns) for larger or more product-y builds.
- `motion-ui`, `motion-foundations`, `motion-patterns` — deeper motion system
  for React/Next.js projects specifically (this skill's motion section is the
  framework-free equivalent for plain HTML/CSS/JS builds).
- `frontend-a11y` — accessibility pass once the visual direction is set.
