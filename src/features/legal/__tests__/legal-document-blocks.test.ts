import { toLegalBlocks } from "@/features/legal/legal-document-blocks";
import { LEGAL_DOCUMENT } from "@/features/legal/legal-documents";

describe("toLegalBlocks", () => {
  test("classifies headings, bullets, and prose", () => {
    expect(
      toLegalBlocks("# Title\n\n## 1. Heading\n\nProse.\n\n- A bullet\n"),
    ).toEqual([
      { kind: "heading", text: "1. Heading" },
      { kind: "paragraph", text: "Prose." },
      { kind: "bullet", text: "A bullet" },
    ]);
  });

  test("strips authoring marks that are not content", () => {
    expect(
      toLegalBlocks("**Operator:** Kingston Du, an [individual](https://x.y)."),
    ).toEqual([
      { kind: "paragraph", text: "Operator: Kingston Du, an individual." },
    ]);
  });

  test("keeps unrecognised lines rather than dropping them", () => {
    // Losing a line silently would remove a term from an agreement.
    expect(toLegalBlocks("> a quote")).toEqual([
      { kind: "paragraph", text: "> a quote" },
    ]);
  });

  test("renders the real document without losing a section", () => {
    const blocks = toLegalBlocks(LEGAL_DOCUMENT.content);
    const headings = blocks
      .filter((block) => block.kind === "heading")
      .map((block) => block.text);

    expect(headings).toHaveLength(11);
    expect(headings[0]).toBe("1. You must be 18 or older");
    expect(headings[7]).toBe("8. Privacy Notice");
    expect(headings[10]).toBe("11. Changes");
    expect(blocks.every((block) => block.text.length > 0)).toBe(true);
    // The `# ` title is the screen's own header, not a block.
    expect(
      blocks.some((block) => block.text.startsWith("Splotty Terms of Use")),
    ).toBe(false);
  });
});
