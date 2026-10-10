# Desk Chats heading and shared New chat action

Decision status: Accepted by the user's explicit request for a Desk heading pencil action.
Created: 2026-10-09 14:03:31 JST (UTC+0900).
Last updated: 2026-10-09 14:03:31 JST (UTC+0900).
Implementation status: Implemented; source-bound release checks must qualify each revision.
Supersedes: Only the no-Desk-heading-creation-button placement choice in
[Standalone chats](standalone-chats.md). Its other decisions remain in force.

## Context and rationale

Projects exposes a pencil beside its Chats heading, but Desk previously labelled
its view list Open chats and offered no equivalent creation action. A user working
in Desk had to change sidebar views or know the global shortcut. The user now
requests the same visible heading/action in Desk.

A separate Desk draft creator would duplicate environment, account, reuse and
first-send ownership. Merely navigating to a new ID would omit those gates.
Reusing the shared button and existing action keeps one implementation and one
meaning for New chat while adding its requested entrypoint.

## Decision and data flow

Desk's visible section label is Chats. Its heading uses SidebarNewChatButton,
the same pencil, tooltip, theme/scale tokens and native keyboard button as
Projects. Its accessible name identifies the active tab group, distinguishing
the action from an existing draft row called New chat.

Sidebar supplies createStandaloneChat to both headings with the same bootstrap
disabled gate. The existing useNewStandaloneChatHandler re-reads the selected
workspace descriptor at the gesture, verifies standalone support and captures
the environment and active group. It reuses an eligible unfinished standalone
draft or seeds a new draft with the existing global defaults. It opens the
pending editor without changing sidebar mode or adding an unsent saved tab.

First Send retains the existing server admission and exact draft promotion.
Per-project actions still create project-associated conversations. The Desk
heading does not infer a project or account from an open row or start a provider.

## Security, compatibility and failure boundaries

No transport, provider, credential, permissions, dependency, persistence or
platform-specific behavior changes. Pending draft content, selected settings,
first-send exclusion, captured-group promotion and late-selection fences are
unchanged. Bootstrap/capability failure retains the existing disabled/error
behavior; no fallback manufactures a project or bypasses server admission.

Desk still lists only open views. Closing those views remains provider-neutral.
The shared callback also retains existing selection cleanup, mobile-sidebar
closing and fixed failure presentation. A rebuilt renderer is needed to adopt
the new heading; old sessions are not repaired or replayed by this change.

## Implementation and qualification

DeskSidebar.tsx owns only the heading presentation; Sidebar.tsx supplies the
existing action. DeskSidebar.browser.tsx qualifies visibility, click/keyboard,
disabled behavior and narrow theme/scale geometry without changing row actions.
The existing full-app standalone fixtures in ChatViewBrowser.shared.tsx exercise
both heading paths, draft reuse/content, zero pre-Send dispatch and exact group
promotion after delayed first-send acknowledgement.

Use pinned Node/Corepack Yarn formatting, lint, typecheck, full default and
browser suites, then LAST `yarn build:desktop --force`. The existing native-host
browser subset includes DeskSidebar; Linux runs the complete browser suite.
Controlled fixtures and hosted platform jobs do not claim live provider behavior.
See [Desk tabs](../desk-tabs.md) and [Chats without projects](../standalone-chats.md).
