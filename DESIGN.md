# Codeply Craft Mobile Companion

## Design reference tool

This project requires a real-app UI reference lookup before any website or design work in this
repo — pull comparable screens from the reference design library before making layout or
pattern decisions, rather than inventing UI blind.

The reference is the local design library: 914 real apps / 6,433 real App Store screenshots
across 10 categories (productivity, finance, shopping, social, travel, food_delivery,
health_fitness, education, entertainment, real_estate), sourced from Apple's public iTunes
Search API and indexed on disk. It needs no external service, no API key, and no login — it
just needs to be present on disk (`codeply-cli/lib/design-library/index.json`), so the lookup
step is always available.

Craft's own in-app agent (the sibling `codeply-cli` engine `main.js` loads, not this Claude
Code session) exposes this as the `design_reference_search` tool in `codeply-cli/lib/tools.mjs`,
querying `codeply-cli/lib/design-library/query.mjs`. It is a required step before writing markup
for any UI a human will look at — see the design-reference rules in `codeply-cli/lib/agent.mjs`
— and is paired with `view_images` so results are actually looked at, not just cited.

Mobbin and Banani MCP integrations have been removed from this project (no `.mcp.json` servers,
no `mobbin_search`/`banani_import` tools) in favor of always using the local reference library
above, which needs no external account or session cookie to work.

## Overview

The companion is a dark, native-feeling control surface for a desktop coding agent. It mirrors the desktop application's charcoal palette but uses a phone-first hierarchy: current run, conversation, then input.

## Color

- App background: `#101012`
- Elevated surface: `#18181c`
- Soft surface: `#232329`
- Borders: `#303038`
- Primary text: `#f2f1f7`
- Muted text: `#aaa9b5`
- Craft violet: `#b19af7`
- Success: `#54d297`
- Danger: `#ff7d70`

## Typography

Use the system UI sans stack. Titles are 700 weight; body is 400–500; metadata is 12–13px. Avoid display fonts and oversized, marketing-style type.

## Components

- A compact top bar exposes PC connection and session controls.
- Activity rows are open, separated by rhythm and hairline dividers rather than stacked cards.
- The composer is pinned above the mobile safe area and uses a single violet send control.
- Approvals rise as a bottom sheet with an explicit action summary and destructive-state treatment.

## Motion

Use 180–220ms ease-out transitions for sheets, connection state, and pressed controls. Reduced-motion mode removes transforms and retains instant state changes.
