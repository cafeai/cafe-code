These images and the recording show the real `ComposerTaskProgress` component with a synthetic one-step plan. No live account or project data is used.

- `before.png` and `after.png`: after opening with Enter, docking to the session rail, and returning to the composer.
- `before-first-press.png` and `after-first-press.png`: after pressing Enter once on the returned control. The old component closes its retained popup; the repaired component opens it.
- `interaction.webm`: the repaired open, dock, return, and first-press sequence.

The before capture uses the unchanged component from dev commit `99fbaec89da429924171c89d66a8f3455e42d9b0`. Temporary capture harnesses were removed after recording. The permanent browser regression verifies the same lifecycle without recording delays.
