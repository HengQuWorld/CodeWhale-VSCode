import { describe, expect, it } from "vitest";
import { classifySkillScope } from "./skill-scope";

describe("classifySkillScope", () => {
  const workspace = "/work/app";

  it("calls a SKILL.md under the workspace a project skill", () => {
    expect(
      classifySkillScope("/work/app/.codewhale/skills/debug/SKILL.md", workspace)
    ).toBe("project");
  });

  it("calls a compatible-harness root inside the workspace a project skill", () => {
    expect(classifySkillScope("/work/app/.claude/skills/x/SKILL.md", workspace)).toBe(
      "project"
    );
  });

  it("calls a global install outside the workspace a global skill", () => {
    expect(
      classifySkillScope("/home/u/.codewhale/skills/review/SKILL.md", workspace)
    ).toBe("global");
  });

  it("does not claim a sibling that merely shares the workspace prefix", () => {
    // "/work/application" starts with "/work/app" as a string but is not inside
    // it; the boundary is what keeps it out.
    expect(classifySkillScope("/work/application/skills/x/SKILL.md", workspace)).toBe(
      "global"
    );
  });

  it("treats a plugin snapshot with no path as global", () => {
    expect(classifySkillScope(null, workspace)).toBe("global");
  });

  it("treats a missing workspace as global rather than guessing a project", () => {
    expect(classifySkillScope("/work/app/.codewhale/skills/x/SKILL.md", "")).toBe(
      "global"
    );
    expect(classifySkillScope("/work/app/.codewhale/skills/x/SKILL.md", null)).toBe(
      "global"
    );
  });

  it("matches a path equal to the workspace root itself", () => {
    expect(classifySkillScope(workspace, workspace)).toBe("project");
  });

  it("ignores a trailing separator on either side", () => {
    expect(classifySkillScope("/work/app/skills/x/SKILL.md/", "/work/app/")).toBe(
      "project"
    );
  });

  it("reads Windows separators both ways", () => {
    expect(
      classifySkillScope("C:\\work\\app\\.codewhale\\skills\\x\\SKILL.md", "C:/work/app")
    ).toBe("project");
  });

  it("compares a Windows drive root case-insensitively", () => {
    expect(
      classifySkillScope("c:\\work\\app\\.codewhale\\skills\\x\\SKILL.md", "C:\\work\\app")
    ).toBe("project");
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(classifySkillScope("/work/App/skills/x/SKILL.md", "/work/app")).toBe("global");
  });
});
