import { describe, expect, it } from "vitest";

import { tidyLeadNotes } from "../lead-notes";

describe("tidyLeadNotes", () => {
  it("keeps one copy of each repeated AI import line and leaves the rest alone", () => {
    const notes = [
      "Vehicle Type: WC",
      "[AI Import Update: Tagged as Prospect]",
      "[AI Import Update: Tagged as Prospect]",
      "Called twice",
      "Called twice",
      "[AI Import Update: Tagged as Prospect]",
      "[AI Import Update: Tagged as Quoted]",
    ].join("\n");
    expect(tidyLeadNotes(notes)).toBe(
      ["Vehicle Type: WC", "[AI Import Update: Tagged as Prospect]", "Called twice", "Called twice", "[AI Import Update: Tagged as Quoted]"].join("\n"),
    );
  });

  it("returns empty notes unchanged", () => {
    expect(tidyLeadNotes("")).toBe("");
  });
});
