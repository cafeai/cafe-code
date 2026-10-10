# Cafe Code style guide

How Cafe Code should look, move and read. Use it for new and changed renderer
UI. These are defaults, not laws: when a surface genuinely needs something
different, do it deliberately and add a token or a note here instead of a
one-off value.

Tokens live in `apps/web/src/index.css` (`@theme inline` and `:root`/`.dark`).
Shared components live in `apps/web/src/components/ui`.

## 1. Principles

1. **Calm and dense, never cramped.** Cafe is a long-running work tool. Prefer
   quiet surfaces, readable secondary text and clear hierarchy to decoration.
2. **One fact, one place.** Don't repeat a title, count, status or provider
   name that is already visible on the same screen.
3. **Motion explains change.** Things that appear, move or swap show where they
   came from, quickly. Motion never delays input.
4. **Never flash, never jump.** Loading states match the final layout, appear
   only when a wait is noticeable, and keep old content while refreshing.
5. **Tokens before values.** Colours, sizes, radii and timings come from the
   theme. If a token is missing, add it.

## 2. Colour

Use semantic tokens. Avoid raw palette classes (`amber-500`, `blue-400`, hex
values) and opacity modifiers on text or borders (`text-muted-foreground/55`,
`border-border/45`); choose the right tier instead. Opacity on a background
tint (`bg-primary/10`) is fine.

Assistant chat prose uses `text-chat-foreground`, preserving its softer 80%
foreground reading colour in both themes. Labels, controls and user messages
keep their existing text tiers.

| Purpose  | Classes                                                                                          | Use                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces | `bg-background`, `bg-sunken`, `bg-card`, `bg-raised` (= `bg-popover`)                            | Page content; sidebar and chrome; in-flow panels (work log, settings sections, composer); floating panels (menus, popovers, dialogs, toasts). Light mode is an off-white page with white cards. |
| Fills    | `bg-muted`, `bg-accent`, `bg-secondary`                                                          | Hover, selected rows, quiet buttons.                                                                                                                                                            |
| Text     | `text-foreground`, `text-muted-foreground`, `text-subtle-foreground`, `text-disabled-foreground` | Primary; secondary (descriptions, labels); supplementary metadata only (timestamps, counts); disabled.                                                                                          |
| Borders  | `border-border-subtle`, `border-border`, `border-border-strong`                                  | Dividers inside a surface; default outlines; inputs and emphasis. Prefer spacing or a surface step over another divider.                                                                        |
| Accent   | `primary`, `ring`                                                                                | Primary actions, selection, focus, links. The user picks this colour, so never hard-code blue.                                                                                                  |
| Danger   | `destructive`, `text-destructive-foreground`                                                     | Stop, delete, irreversible actions.                                                                                                                                                             |

### Status

One vocabulary everywhere a chat's state is shown: sidebar rows, project rows,
Desk tabs, the Desk list, the command palette and Atrium. Navigation derives it
with `resolveThreadStatusPill` and renders it with `ThreadStatusLabel`.
`getThreadStatusPill` owns the shared colours and indicators; avoid a second palette.

| State     | Token                                       | Meaning                                          |
| --------- | ------------------------------------------- | ------------------------------------------------ |
| Running   | `status-running` (an accent-colour spinner) | Working, connecting or confirmed background work |
| Attention | `status-attention` (amber)                  | Needs approval, needs input, plan ready          |
| Done      | `status-done` (green)                       | Finished and not yet viewed                      |
| Error     | `status-error` (red)                        | Latest turn failed and not yet viewed            |
| Idle      | no dot                                      | Viewed and not working                           |

Text on a status tint uses the matching `text-status-*-foreground`. Projects
show their most urgent chat's state.

Atrium retains recently terminal work even after a chat has been read. Its
projection determines the card's lifecycle, using `getThreadStatusPill` for
the same presentation. Reading a chat clears its navigation unread indicator
while the retained Atrium card remains available.

Show live activity once, in the compact line above the composer. Use specific
plain-language states when the provider supplies evidence: Running command,
Waiting for an agent, or Waiting for your answer. Confirmed native work can
continue after the response ends; keep its navigation spinner and show
Background work running. The line opens the existing Tasks surface when there
is work to inspect. Avoid a second timer or a new status panel. See
`docs/live-chat-activity.md` for the evidence boundary.

Decorative layers (sidebar stars, ambiance, Atrium scene) derive their colour
from the accent and sidebar colour settings and always sit behind content.

## 3. Typography

DM Sans ships with the app (`font-sans`); code, paths and key hints use
`font-mono`. Every size is rem-based so the Interface size setting scales it.
Don't use pixel sizes (`text-[11px]`) and don't go below 11px.

| Class                 | Size      | Use                                                     |
| --------------------- | --------- | ------------------------------------------------------- |
| `text-2xs`            | 11px      | Timestamps, captions, badges, tiny metadata             |
| `text-xs`             | 12px      | Descriptions, secondary UI, menu hints                  |
| `text-ui`             | 13px      | Dense UI: sidebar rows, settings row titles, menu items |
| `text-sm`             | 14px      | Default controls and chat prose                         |
| `text-base`           | 16px      | Section and dialog titles                               |
| `text-lg` / `text-xl` | 18 / 20px | Page titles                                             |
| `text-2xl`+           | 24px+     | Hero numbers (Usage, Atrium) only                       |

- Weights: 400 body, 500 labels and controls, 600 titles.
- Sentence case for headings, labels and buttons.
- `label-overline` is the one uppercase section label. Use it at most once per
  surface and never put counts in it.
- Numbers that change (timers, tokens, cost) use `tabular-nums`.

## 4. Shape, space and elevation

| Radius               | Use                                                            |
| -------------------- | -------------------------------------------------------------- |
| `rounded-sm` (6px)   | Chips, badges, menu items, kbd, checkboxes                     |
| `rounded-md` (8px)   | Tooltips, small controls inside larger ones                    |
| `rounded-lg` (10px)  | Buttons, inputs, selects, menus, popovers                      |
| `rounded-xl` (14px)  | In-flow cards: work log, banners, code blocks, message bubbles |
| `rounded-2xl` (18px) | Dialogs, sheets, settings sections, the composer, Atrium cards |
| `rounded-full`       | Pills, avatars, status dots                                    |

Nested corners use `rounded-[calc(var(--radius-*)-1px)]`; avoid other arbitrary
radii.

- **Spacing:** 4px grid. Control heights 24, 28 and 32px (`Button` sizes
  `xs`, `sm`, default on desktop). List and menu rows are 28–32px.
- **Elevation:** in-flow surfaces are flat (surface step plus border). Only
  floating panels get shadows, and they come from the primitives.
- **Icons:** Lucide only. `size-3.5` inline with text, `size-4` in buttons,
  `size-3` in dense metadata. Icon-only buttons need an `aria-label` and a
  tooltip.

## 5. Layout

- **One title per view.** A chat title appears in the header or its Desk tab,
  not both; extra context such as the project goes in a tooltip.
- **Desk tabs** fill the top window bar, using a taller row instead of stacked
  title and tab rows. Leave native window controls clear and keep buttons out
  of the drag region. Open actions live in the tab menu; source-build status
  sits beside Settings in the sidebar footer. Connection issues for the selected
  server temporarily replace that badge; build status returns after recovery.
- **Settings pages** use `SettingsPageContainer` at its standard width and
  start with a page title. Its `wide` variant is for tables and dashboards only.
- **Chat content** uses the shared reading width; the composer aligns to it.
- **Composer controls** keep computer use directly available for local Mac
  Codex/Claude chats. Build/Plan, Goal and the other secondary controls share
  the expandable extra-controls dropdown at every width.
- **Queued and steering messages** form an attached top section of the composer,
  with one divider above the typing area. Anchor the tools tab above the combined
  box so it stays clear of queue content at narrow widths too.
- Empty space is fine. Don't fill it with explanatory text.

## 6. Components

Reach for `components/ui` first. If a primitive lacks a variant, add the
variant there.

| Need                           | Use                                     | Instead of                            |
| ------------------------------ | --------------------------------------- | ------------------------------------- |
| Buttons, icon buttons          | `Button`                                | raw `<button>` with bespoke padding   |
| A dropdown choice              | `Select`                                | native `<select>`                     |
| 2–5 exclusive options          | `SegmentedControl`                      | custom tab rows or inverted pills     |
| An action list or context menu | `Menu`                                  | custom popup lists                    |
| A floating panel               | `Popover`                               | positioned divs                       |
| A modal                        | `Dialog`, `AlertDialog`                 | custom portals                        |
| An explanation or caveat       | `Tooltip`, `InfoTip`                    | `title=` attributes, extra paragraphs |
| A tag or state                 | `Badge`                                 | hand-rolled chips                     |
| An empty state                 | `Empty`                                 | centred muted paragraphs              |
| Loading                        | `Skeleton`, `Spinner`, `useDelayedFlag` | other spinner icons                   |

## 7. States

- **Hover:** one surface step (`bg-accent`) with a fast colour transition.
- **Selected:** accent-tinted or `bg-accent` background plus foreground text,
  never bold alone.
- **Focus:** a visible ring on keyboard focus (primitives include it;
  custom elements use `focus-ring`).
- **Disabled:** 50% opacity. If a tooltip explains why, keep it focusable.
- **Pressed:** a slightly darker fill or a 0.98 scale, at most 100ms.
- On devices with hover, message timestamps and actions use a compact area
  outside short user bubbles and beneath assistant text. Hidden metadata must
  not add an empty line inside a bubble; hover and keyboard focus must not
  resize timeline rows. Touch devices keep these controls visible in the normal
  message flow, and long-message expand controls always retain their own space.

## 8. Motion

### Tokens

| Token                 | Value                      | Use                                    |
| --------------------- | -------------------------- | -------------------------------------- |
| `--duration-fast`     | 120ms                      | Hover, colour, small fades, every exit |
| `--duration-base`     | 160ms                      | Menus, popovers, tooltips, view swaps  |
| `--duration-slow`     | 220ms                      | Dialogs, sheets, side panels           |
| `--duration-emphasis` | 300ms                      | Rare: toasts, onboarding               |
| `ease-out`            | `cubic-bezier(.2,.8,.2,1)` | Anything appearing or settling         |
| `ease-in`             | `cubic-bezier(.4,0,1,1)`   | Anything leaving                       |
| `ease-in-out`         | `cubic-bezier(.4,0,.2,1)`  | Moving between two on-screen positions |

In classes: `duration-(--duration-base) ease-out`.

The entrance utilities `animate-enter-rise`, `animate-enter-fade`,
`animate-enter-scale`, `animate-enter-from-end`, `animate-enter-from-start` and
`animate-enter-from-bottom` cover mount-time motion.

### Patterns

| Situation                                 | Motion                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu, select, popover, tooltip            | Fade + scale from 0.96 at the anchor (`origin-(--transform-origin)`): base/ease-out in, fast/ease-in out                                           |
| Dialog, command palette                   | Backdrop fade; panel fade + slight scale and rise: slow in, fast out                                                                               |
| Sheet, side panel, session rail           | Slide from its edge + fade                                                                                                                         |
| Sidebar collapse                          | The existing 200ms width/position slide (a documented exception, required by `AGENTS.md`) with `ease-out`; the chrome stays mounted while it exits |
| Switching chat, Desk tab or settings page | New content `animate-enter-rise` once it is ready; the old view leaves instantly                                                                   |
| Push/back views (subagent detail)         | `animate-enter-from-end` in; back uses `animate-enter-from-start`                                                                                  |
| List add, remove, reorder                 | `@formkit/auto-animate`                                                                                                                            |
| Expand/collapse                           | Rotate the chevron; revealed content `animate-enter-rise`                                                                                          |
| Segmented control, tabs                   | Indicator slides with `transform`                                                                                                                  |
| Toast                                     | Slide + fade: emphasis in, fast out                                                                                                                |
| New chat message                          | `animate-enter-rise`, only for rows appended live — never for rows a virtualized list re-mounts while scrolling                                    |
| Looping status (spin, pulse)              | The existing stepped `animate-*` tokens only                                                                                                       |

### Rules

- Animate `opacity`, `transform`, `translate` and `scale`. Width, height,
  left or top need a documented reason (the composer tab and sidebar slide
  are the existing ones).
- A minimized composer tools tab is a shallow lip. Its decoration may animate
  height and its caret may lower; keep the larger click area and editor steady.
- Every overlay animates in **and** out, and exits are faster than entrances.
- Animations are interruptible, and controls are usable immediately.
- Never animate streaming tokens, per-event updates or virtualized re-mounts.
- `prefers-reduced-motion`: movement and scaling are removed globally and
  entrances become plain fades. Don't override that.
- No new infinite animations outside the stepped status tokens; respect the
  background-animation pause.

## 9. Loading and waiting

1. **Under ~150ms, show nothing.** `useDelayedFlag(pending)` shows an indicator
   after 250ms and keeps it at least 300ms, so it never flashes.
2. **First loads** use a skeleton that matches the final layout. No centred
   spinners in content areas.
3. **Refreshes** keep the old data visible with at most a small header spinner.
   Say "last known" only after a refresh fails.
4. **"Nothing here" messages** appear only after loading finishes.
5. **Spinners** go inside buttons (keep the label and width) or small inline
   spots.
6. **Media** (images, diagrams, screenshots) gets its space reserved and fades in.
7. **Waits over ~1s** get a short label; known sizes show progress; anything
   that can fail offers Retry.
8. **Connection warnings** wait about a second so brief reconnects don't flicker.

## 10. Copy and information density

- **Labels and descriptions.** Labels name the control. Descriptions are
  optional: add one only when the label and control are ambiguous, keep it to
  one line (about 80 characters) and never add a second sentence.
- **Don't repeat.** Never restate what a switch, badge, button or heading
  already shows, and don't narrate the screen ("the summary above remains
  available").
- **Delivery status stays with the message.** Show Sending, Received and
  delayed pickup in the steering shelf. Routine delivery receipts and periodic
  "still working" checks stay in diagnostics, rather than repeating as work-log
  rows. Keep actual failures visible and preserve exact-message confirmation.
- **Metadata on demand.** Timestamps, durations, paths, IDs, environment
  variable names, version requirements and technical caveats go in a hover,
  an `InfoTip` or a collapsed "Advanced" section.
- **No implementation words in UI text** (daemon, app-server, SQLite, RPC,
  loopback, native, fetch). Describe what the user sees or can do.
- **Required disclosures.** Security, billing and permission disclosures
  required by `AGENTS.md` stay visible at the point of action as one short
  line, with any detail in an `InfoTip`. Keep their exact required phrases
  (for example "Status unavailable" and "Fast status not recorded").
- **Toasts** are for failures or actions that need you. Confirmations such as
  copied or saved stay inline. Error text says what to do next.
- **One name per concept.** User-facing text says **chat**, never "thread"
  (code and protocol identifiers keep their names). Use one name per access
  mode and per interaction mode.
- **Sentence case, and "…" for in-progress labels.**

## 11. Before shipping a UI change

A quick self-check, not a gate:

- [ ] Light and dark
- [ ] Interface size 80% and 130%
- [ ] Narrow width (~430px)
- [ ] Reduced motion
- [ ] Loading, empty and error states
- [ ] Keyboard focus and tooltips on icon-only controls
- [ ] No new hard-coded colours, pixel font sizes or one-off radii
