---
name: codeply-taste
description: Codeply's design layer. Use for any design a person will look at - a website or landing page, app screens, a slide deck, a document, a poster, a social post, a logo - when it has to look designed, not generated. It deals an art direction from a research library (design_direction), checks the result against measured rules and a real render (design_lint), and holds the type, colour, layout, copy, imagery and motion guides in references/.
---

# Codeply taste

A design that looks generated has the same tells every time: the category's default
palette, a centred hero with a gradient, three icon cards, pill buttons with a glow,
and copy that says nothing. This skill exists to make something else: a design with
one idea, carried by type, colour, pictures and layout that were chosen for it.

The research behind it is in `references/research.md`. The short version: strong
pages commit to one idea, set type at few sizes far apart, use colour in planned
proportions, and use real pictures. Weak pages decorate.

## The workflow

1. **Know the brief.** Who is it for, what one thing must it make them feel or do,
   what real material exists (a name, a product, photographs, numbers). If a fact
   the design depends on is missing and only the person can say, ask once with
   ask_user. Otherwise decide and say what you decided.

2. **Deal a direction** (websites, landing pages, and the look of an app):
   `design_direction` with a one-line `brief`, a `sector` and a `tone`. Use
   `options` = 3 to see three directions first when the brief is open, then
   `direction` = the chosen id for the full sheet. The sheet gives the idea,
   composition, type, palette, imagery, sections and the pitfalls to avoid.
   Follow it. Re-deal one part with `redraw` (`type`, `palette`, `hero`, `photos`,
   `section:<role>`) rather than ignoring it. For slides, documents, posters and
   social posts, a direction is optional: when the subject has a brand or sector,
   deal one and use its palette and type.

3. **Look at real work** for app screens: `design_reference_search` for the screen
   type, then `view_images` on 2 to 4 results from different apps, and build from
   what you saw.

4. **Read the guide you need** before writing: `references/type.md` and
   `references/colour.md` always; `references/layout.md` for pages and screens;
   `references/copy.md` for every headline and button; `references/imagery.md`
   when pictures are involved; `references/motion.md` for websites;
   `references/tells.md` for what not to do. Read with read_file on
   `<skill folder>/references/<name>.md` (the use_skill output gives the folder).

5. **Write it** (see "Formats" below). Real words, not lorem ipsum: write copy the
   way `references/copy.md` says. Real pictures: `image_search`, then
   `fetch_image` into `assets/`, and credit them; or the dealt photographs from the
   direction sheet.

6. **Check it, once or twice**: `design_lint` with the `path` and the `kind`, when
   the design is complete (not after every edit). Fix every FAIL in one or two edits
   and check once more; three checks per request at most. WARNs are optional: fix
   the quick ones alongside the FAILs. Look at the attached screenshots the way
   `references/critique.md` says and fix what is plainly wrong in the same edit.
   Once a check passes, stop checking.

7. **Say what you made** in two or three lines: the idea, the type and colour, and
   anything you decided for the person. Never say a design "works": its buttons and
   forms are pictures of buttons and forms until someone builds it.

## Formats

One self-contained HTML file per design, so it opens anywhere: CSS in a `<style>`
tag, any script inline, fonts from Google Fonts with `display=swap`, pictures in
`assets/`. No frameworks, no build step, no external scripts except fonts.

- **website**: a full page at desktop and phone widths, responsive, with
  `<meta name="viewport" content="width=device-width, initial-scale=1">`.
  Motion from `assets/base.css` and `assets/base.js` (copy them in, they are
  small): transform and opacity only, with a reduced-motion fallback.
- **app**: the screens of the flow side by side on a neutral canvas, each one a
  390 by 844 frame (`<section class="screen">`) with a short label under it. Real
  content in every state: the empty state, a loaded list, an error, as the brief
  needs.
- **slides**: a 16:9 deck, each slide a `<section class="slide">` of exactly
  1280 by 720 pixels, stacked with a gap. One idea per slide, big type, real
  numbers. No bullet walls: three lines at most.
- **doc**: pages of 816 by 1056 pixels (US Letter at 96 dpi; A4 is 794 by 1123),
  each a `<section class="page">` with its own margins, set for print too
  (`@page` and `break-after: page`). A real typographic hierarchy, not a web page
  squeezed onto paper.
- **poster**: one `<section class="poster">` at the asked size (1080 by 1350 by
  default).
- **social**: one or more `<section class="post">` at 1080 by 1080 (or 1080 by
  1350 / 1080 by 1920 when asked).
- **logo**: the mark as inline SVG, shown on light and dark grounds, at large and
  small sizes, with the wordmark lockup. Simple enough to read at 16 pixels.

Only pages and app screens move. Slides, documents, posters, posts and logos are
still.

## What never ships

The registry is `references/tells.md`; `design_lint` catches most of it. The ones
that matter most: gradient text and purple-blue gradients; glassmorphism; glow
and coloured shadows on buttons; three identical icon cards; everything centred;
eyebrow labels over every heading; emoji as icons; the cream-and-terracotta and
the purple "AI" palettes; grey body text with low contrast; more than two
typefaces; copy that could describe any product ("Unlock the power of...",
"Seamless", "Elevate").
