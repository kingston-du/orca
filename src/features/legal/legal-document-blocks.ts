export type LegalBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string };

/**
 * Markdown emphasis, inline code, and link syntax are authoring marks, not
 * content. Stripping them is the whole reason this exists: the document has to
 * stay valid Markdown for the published web page and for the hash, while the
 * in-app screen shows prose rather than asterisks.
 */
function stripInlineMarks(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * Turns the bundled Markdown into the few block shapes the legal screen draws.
 *
 * Deliberately not a Markdown library: the input is one document this project
 * writes and hashes, the output is three block kinds, and a parser dependency
 * would carry a renderer, a sanitiser, and a bundle cost for that. Anything
 * unrecognised falls through as a paragraph, so an unhandled construct shows
 * its text rather than disappearing from an agreement.
 */
export function toLegalBlocks(content: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line.length === 0) continue;
    // The `# ` title is dropped: the screen draws its own header, and repeating
    // it would read as a duplicate heading to VoiceOver.
    if (line.startsWith("# ")) continue;

    if (line.startsWith("## ")) {
      blocks.push({ kind: "heading", text: stripInlineMarks(line.slice(3)) });
      continue;
    }

    if (line.startsWith("- ")) {
      blocks.push({ kind: "bullet", text: stripInlineMarks(line.slice(2)) });
      continue;
    }

    blocks.push({ kind: "paragraph", text: stripInlineMarks(line) });
  }

  return blocks;
}
