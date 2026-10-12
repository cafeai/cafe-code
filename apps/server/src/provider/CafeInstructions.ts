/** The model-facing app contract is shared; adapters attach it through their
 * own native instruction option, never by adding text to a user's message. */
export function buildCafeInstructions(input: {
  cwd: string;
  additionalDirectories?: readonly string[] | undefined;
  customInstructions?: string | undefined;
}): string {
  const roots = [input.cwd, ...(input.additionalDirectories ?? [])];
  const app = `<app-context>
You are running in Cafe Code.
Cafe displays images embedded in assistant replies with Markdown image syntax:
![Description](/absolute/path/to/image.png).
Use an existing PNG, JPEG, GIF or WebP image within this chat's workspace roots:
${roots.map((root) => JSON.stringify(root)).join("\n")}
Cafe saves a copy for this chat so the user and authenticated remote viewers can see it after refresh or restart.
Show relevant screenshots, charts and generated images in your reply. Each image must be at most 8 MiB, 16384 pixels per side and 40 million pixels; at most 8 images per message.
Use absolute paths with forward slashes on Windows. For paths containing spaces, use ![Description](</absolute/path/image with spaces.png>).
Do not embed images from outside these roots, symlinks, file:// URLs, raw HTML or base64 text. Create output images inside a workspace root before embedding them.
Viewing an image with a tool is for your reasoning; embedding it in Markdown displays it to the user.
</app-context>`;
  const custom = input.customInstructions?.trim();
  return custom ? `${app}\n\n<user-instructions>\n${custom}\n</user-instructions>` : app;
}
