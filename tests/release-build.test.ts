// Failure mode F88 in docs/failure-modes.md: the build AMO signs has no test-only code.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function build(...flags: string[]) {
  const out = join(mkdtempSync(join(tmpdir(), "fmd-ext-")), "ext");
  dirs.push(out);
  execFileSync("node", ["scripts/build-ext.mjs", "--out", out, ...flags], { stdio: "pipe" });
  return { out, manifest: JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")), background: readFileSync(join(out, "background.js"), "utf8") };
}

describe("demo extension builds", () => {
  it("the release build has no test-only code (F88)", { timeout: 60_000 }, () => {
    const release = build();
    expect(release.manifest.content_scripts).toBeUndefined();
    expect(existsSync(join(release.out, "content.js"))).toBe(false);
    expect(existsSync(join(release.out, "e2e"))).toBe(false);
    // Words only the test ops have (transformers.js itself has "transformers-cache" and "remoteHost").
    for (const word of ["not a model", "message.remoteHost", "paraphrase-MiniLM"]) expect(release.background, word).not.toContain(word);
    expect(release.background).toContain("local-chat");
  });

  it("the e2e build has the test ops (F88)", { timeout: 60_000 }, () => {
    const e2e = build("--e2e");
    expect(e2e.background).toContain("not a model");
    expect(e2e.background).toContain("message.remoteHost");
  });
});
