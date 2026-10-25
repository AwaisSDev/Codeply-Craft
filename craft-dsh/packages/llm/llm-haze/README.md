# llm-haze

Haze 2, Codeply's hosted model, as the engine's model adapter. Craft only.

Route `haze`, model `haze-2`. The Haze router picks the real model (Sonnet, Haiku, or a free model) once per user turn.

The adapter never sees an account token. Craft starts the engine with two environment variables:

| Variable | What |
|---|---|
| `CODEPLY_HAZE_BRIDGE_URL` | Loopback URL of Craft's Haze bridge |
| `CODEPLY_HAZE_BRIDGE_TOKEN` | Per-launch secret the bridge checks |

The bridge (`dsh-engine.js` in Craft) forwards each request to `ai.chat()` with `route.auto`, so sign-in, token refresh, the device id, Haze routing state, limits and the direct fallback all stay where they already are.

Images and files reach Haze as text placeholders: the route declares text-only input.
