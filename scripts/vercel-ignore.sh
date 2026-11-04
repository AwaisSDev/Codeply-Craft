#!/usr/bin/env bash
# Vercel's "ignored build step" for the phone app (vercel.json ignoreCommand points here; that setting is
# capped at 256 characters). Exit 0 = skip this deploy, exit 1 = build it.
# Only main is deployed (previews of the work branch are never used and count against the plan), and only when
# something the phone app is built from changed since the last deploy.
[ "$VERCEL_GIT_COMMIT_REF" = "main" ] || exit 0
P=${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}
git cat-file -e "$P^{commit}" 2>/dev/null || exit 1
git diff --quiet "$P" HEAD -- 'phone*' 'mobile*' bot-avatar.js attachments.js link-chips.js vendor logo.png assets/agents \
  scripts/prepare-mobile.js scripts/vercel-ignore.sh vercel.json codeply-cli/skills/codeply-taste \
  Gmail.webp Slack.webp Github.webp Vercel.png Supabase.jpg
