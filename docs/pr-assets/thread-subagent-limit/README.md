These images use Cafe's full-app browser test fixture with synthetic messages and provider responses. They contain no live account or project data.

- `before.png`: the composer from upstream dev commit `99fbaec89da429924171c89d66a8f3455e42d9b0`.
- `after.png`: the composer with the new Agents control.
- `dialog.png`: the thread limit dialog with an explicit limit of four.
- `interaction.webm`: a Chromium recording of opening the control and entering the limit. The recording includes the test app startup.

The capture used the existing composer fixture's dictation-control case. The before image loaded the original `ChatComposer.tsx` from the base commit. Temporary capture harnesses were removed after recording. The focused `ThreadAgentControl.browser.tsx` tests verify save, reset, invalid input, exact environment routing, and failed-write behavior.
