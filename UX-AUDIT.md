# Sutra — Senior UI/UX Audit

**Depth:** Deep audit · **Platform:** Android (Capacitor WebView) + PWA · **Method:** code review + app rendered locally (Vite dev server) and screenshotted across mobile (390×844) and desktop (1280×900). Evaluated against Nielsen's 10 heuristics, WCAG 2.2 AA, and Core Web Vitals.
**Date:** 2026-06-05.

> Note on rendering: the local web build can't open populated data (sql.js lacks FTS5; the device build has it), so Memory/Conversation **populated** visuals are marked `needs-verification (device)`. Chrome, onboarding, capture, settings, chat, graph, nav, and empty/error states were audited live.

---

## Executive summary

Sutra has a genuinely strong, cohesive visual foundation — a confident dark theme, a clear purple accent, honest privacy copy, and unusually good empty states. It reads as a real product, not a prototype. The gaps are: (1) **error resilience** — a single failed data read paints a scary full-width banner over otherwise-fine pages; (2) **spatial rhythm** — several screens have large dead zones that make them feel sparse/unfinished; (3) **accessibility** — missing landmark/nav semantics and some low-contrast text; and (4) **large-viewport** — the phone layout is centered on desktop with no adaptation. Several issues from the earlier code audit were already fixed this session (noted ✅).

**Scorecard (0–4, higher is better):**

| Category | Score | Notes |
|---|---|---|
| Visual hierarchy | 3.5 | Strong focal points; sparse lower halves hurt it |
| Typography | 3.5 | Clean scale; size-token sprawl in inline styles |
| Spacing & layout | 2.5 | Dead zones on Capture/Onboarding; weak vertical rhythm on tall screens |
| Color & contrast | 3 | Cohesive palette; faint text likely sub-4.5:1 |
| Navigation & IA | 4 | Clear 5-tab nav, active states, header titling |
| Affordance & interaction | 3.5 | Good buttons; a couple of states missing |
| Feedback states | 3 | Great empty states; error state too aggressive |
| Empty & error states | 3.5 | Empty states excellent; error banner over-triggers |
| Consistency | 3.5 | Strong design-system adherence overall |
| Accessibility | 2.5 | Missing nav semantics; contrast; reduced-motion |
| Large-viewport / adaptive | 2 | Phone layout centered on desktop, big gutters |
| **Overall** | **3.1** | Solid product; targeted fixes lift it to excellent |

---

## Findings (severity 4 critical → 1 cosmetic; 0 = strength)

### P0 — fix now

**[4] Error banner hijacks otherwise-healthy pages on any partial load failure.**
Location: Memory, Settings, Graph (all viewports). Heuristic: #9 (help users recover), #1 (status).
Evidence: every data page renders "Something went wrong loading this. Try reopening the app." as a red full-width bar — *and still shows correct content/empty state beneath it*. The page loaders use `Promise.all([...])`, so one failing read rejects the whole batch and trips the global error bar. (On web it's the FTS5 limitation; on device the same pattern fires if any single query fails.)
Fix: load independent data sources with `Promise.allSettled` (or per-section try/catch) so one failure degrades only its section; reserve the top-level error bar for true full-page failures, and make it dismissible. Show a quiet inline retry on the affected section instead of a global red banner.

**[3→done ✅] "No summary yet — still processing…" froze forever on failed extraction.**
Fixed this session: conversations now carry a `status`; Memory shows a real "Processing…" vs "Couldn't process — open to retry" state.

### P1 — this sprint

**[3] Large dead zones / weak vertical rhythm on tall screens.**
Location: Capture (hero card's lower ~40% is empty; page body below is mostly void), Onboarding (large gap above the waveform art). Heuristic: #8 (aesthetic/minimalist ≠ empty), category: spacing & layout.
Evidence: on 390×844 and especially desktop, the mic card is a tall rounded box with content only in its top half; the rest is dead space, and the page continues empty to the nav.
Fix: tighten the hero card to its content (or fill the lower half with a purposeful element — last-session chip, today's recap teaser, or a subtle "what Sutra captures" affordance). On Onboarding, anchor content to a consistent optical center and reduce the top void. Adopt an 8-pt rhythm for card internal padding.

**[3] Low-contrast secondary text.**
Location: hints, examples (italic), timestamps, the `faint`/`muted` classes across Settings/Memory/Capture. WCAG 1.4.3 (4.5:1).
Evidence: the italic example "chalo kal kaam karte hain" and helper lines sit in a faint gray on near-black that visually reads below AA. `needs-verification` with a contrast probe, but flagged on inspection.
Fix: raise `--text-2`/`--faint` luminance until body-size helper text clears 4.5:1 (large text 3:1); verify each token against the surface it sits on.

**[3] Missing navigation/landmark semantics.**
Location: bottom `Nav`. WCAG 1.3.1, 4.1.2.
Evidence: `<nav>` has no `aria-label`; the active tab conveys state only via color (no `aria-current="page"`), and color-only state also trips 1.4.1.
Fix: add `aria-label="Primary"` to the nav and `aria-current="page"` on the active item.

**[2→done ✅] Several interaction/correctness UI bugs** fixed this session: invisible relevance score-bar (`scaleX(0)`→width), native `alert()/confirm()` replaced with in-app notice + two-step wipe, stale conversation flashing on navigation (now resets to skeleton), speaker-name input got an `aria-label`, action-toggle got a descriptive label.

**[2] Conversation detail header shows "Conversation," not the title.** `needs-verification (device)`. The app bar is uninformative while reading a specific memory. Fix: lift the loaded title into the header (shared state / title hook).

### P2 — backlog

- **[2] Large-viewport not adapted.** Desktop renders the phone column centered with wide empty gutters and a floating bottom nav. Evidence: 1280×900 capture. Fix: constrain content to a comfortable max-width and either keep a centered single column intentionally or move nav to a side rail on ≥1024px. (Lower priority if Android is the only near-term target.)
- **[2] `key={index}` on dynamic lists** (chat messages, action items, facts). Risk: wrong-node reuse/flicker on reorder. Fix: stable ids (conversation/action ids; a monotonic id for chat messages).
- **[2] Pill toggles aren't a real tablist.** Memory's Conversations/Search/Actions use bare buttons. Fix: `role="tablist"`/`role="tab"`/`aria-selected`.
- **[2] No reduced-motion handling.** The waveform rAF loop and `.turn` rise animation ignore `prefers-reduced-motion`; on ConversationDetail every turn animates at once (waterfall) on load. Fix: gate animations behind the media query; scope `rise` to the live capture transcript only.
- **[2] Light theme defined, no switch.** `[data-theme="light"]` tokens exist but nothing toggles them. Fix: wire `prefers-color-scheme` (and/or a Settings toggle).
- **[2] Settings over-fetches.** Every action calls a 6-endpoint `reload()`. Fix: targeted refreshes.
- **[2] Chat auto-scroll fires on `busy` toggle** → double smooth-scroll jank. Fix: depend on messages only.

### P3 — polish

- **[1] Font-size token sprawl** (11/12/12.5/13.5/14 inline). Fix: 3–4 `--text-*` tokens.
- **[1] Dead components shipped** (`HomeView`, `Preview`) — confirm tree-shaken or move to a dev-only dir.
- **[1] Search results have no loading skeleton** (layout shift on arrival).

---

## Strengths (keep these)

- **[0] Honest, calm privacy copy** front-and-center ("Audio is processed in the cloud and never stored"), and the two capture-mode promises are clearly separated — trust-building and on-brand.
- **[0] Excellent empty states.** Chat's suggestion chips ("What did we decide about the project?"), Graph's "Try again", and Memory's zero-state all guide the next action rather than showing a blank.
- **[0] Clean, cohesive dark design system** — consistent cards, accent usage, and a single confident focal point per screen (the lit mic, the sparkle).
- **[0] Clear primary navigation** with icon+label, active highlighting, and a per-screen header title.
- **[0] Onboarding is focused** (4 steps, progress dots, a single pinned primary action).

---

## 30 / 60 / 90 roadmap

- **30 days (quick wins, high impact):** error-resilience refactor (`allSettled` + sectioned retry, dismissible banner); contrast token bump; nav `aria-label`/`aria-current`; tighten Capture/Onboarding dead zones; stable list keys.
- **60 days (structural):** accessibility pass (tablist roles, reduced-motion, focus order, icon-button labels sweep); ConversationDetail header title; font-size tokens; remove dead components.
- **90 days (foundational):** large-viewport/desktop adaptation; light-theme switch; perceived-performance pass (skeletons everywhere data loads, no layout shift); on-device runtime a11y verification (TalkBack walk, largest font scale, live contrast).

---

*Items marked ✅ were fixed during the 2026-06-04/05 reliability+polish pass. Items marked `needs-verification (device)` require a TalkBack / real-render check on the Galaxy device once the latest build is installed.*
