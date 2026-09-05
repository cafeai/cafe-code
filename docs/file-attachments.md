# File attachments and editable message queues

Drop files into the composer, paste files, or use the attachment picker. Images keep their thumbnail previews; other files appear as compact filename/size pills in the composer, queue and conversation history. A message can contain files without any accompanying text.

## Files and previews

All file extensions are accepted, including HTML, code, TeX, PDF, DOCX and unknown binary formats. Cafe uploads a snapshot to the selected environment, so the provider reads that copy even if the original file later changes. Existing workspace `@` references still point to workspace files.

- Up to eight attachments per message.
- Generic files: up to 25 MiB each; images: up to 10 MiB each.
- Combined attachment size: up to 80 MiB.
- Uploading or failed files stay visible and block sending until completed or removed. A failed upload can be retried while the selected file is still available; after a reload, select the file again if its upload never finished.
- Click a file pill for a bounded plain-text preview, or its download icon to save the original. HTML, SVG, scripts, macros and embedded links are never executed by the preview.

Codex and Claude receive a small attachment inventory with private copies they can read on demand. This does not paste entire documents into every prompt or grant broader filesystem permissions. PDF and DOCX files also receive a bounded text view where possible. PDF images, layout and scanned text are not OCR'd; DOCX headers, footers and embedded content are not part of its body-text view. The provider is told when extraction is partial or unavailable, and still has the original file. Accepting a binary file does not mean a model can understand every format.

Local OpenCode and Grok use the same file inventory. A separately hosted OpenCode server cannot read the Cafe backend's private files; Cafe reports that limitation instead of silently dropping those attachments.

Uploaded snapshots are private to the selected Cafe backend and bound to the exact thread. They survive transcript reverts because an unsent queue or draft can still refer to them. Deleting the thread removes its stored files and derived text views. Removing a pill removes the reference, not necessarily the stored snapshot immediately.

## Editing queued messages

Use the pencil on an **unsent** queued message to bring it back into the composer. Edit its text, images or file pills, then choose **Save to queue** to replace that queued message, or **Cancel** to leave it unchanged. Both actions restore the draft you had open before editing. Saving an edit does not immediately send it.

A message already being sent or accepted as steering cannot be edited as if it were unsent. Send another steer to amend it. A previous steer waiting to be processed no longer prevents a second steer once its submission has been acknowledged; the short submission lock still prevents duplicate or overlapping sends.

Unsent queues retain bounded attachment metadata across reloads. If a reload happens during dispatch and delivery is uncertain, the recovered item requires an explicit action rather than automatically replaying a potentially accepted message.
