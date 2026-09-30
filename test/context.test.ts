import { expect, test } from "bun:test";
import { normalizeContext } from "../src/context.mjs";
const developer = (content: any) => ({ role: "developer", content });
const memory = "<global-memory>\nA\n</global-memory>";
const catalog = (
  entries: string,
  root = "/skills",
  policy = "Read skills first.",
) => `<skills_instructions>
## Skills
${policy}
### Skill roots
- \`r0\` = \`${root}\`

### Available skills
${entries}
</skills_instructions>`;
const a = "- alpha: alpha description (file: r0/alpha/SKILL.md)";
const b = "- beta: beta description (file: r0/beta/SKILL.md)";
const request = (input: any[]) => ({ model: "sonnet", input });

test("unchanged requests retain their identity and duplicate user quotes", () => {
  const original = request([
    developer(memory),
    { role: "user", content: memory },
    { type: "function_call_output", output: memory },
  ]);
  expect(normalizeContext(original)).toBe(original);
});

test("only consecutive-equivalent memory is suppressed; changed and reverted memories survive", () => {
  const changed = memory.replace("A", "B");
  const result = normalizeContext(
    request([
      developer(memory),
      developer(memory),
      developer(changed),
      developer(memory),
    ]),
  );
  expect(result.input).toEqual([
    developer(memory),
    developer(changed),
    developer(memory),
  ]);
});

test("compaction restores each kind of context independently", () => {
  for (const context of [memory, catalog(a)]) {
    const original = request([
      developer(context),
      { type: "compaction", encrypted_content: "opaque" },
      developer(context),
    ]);
    expect(normalizeContext(original)).toBe(original);
  }
});

test("unchanged skill catalogs disappear without mutating original objects", () => {
  const first = catalog(a);
  const original = request([developer(first), developer(first)]);
  expect(normalizeContext(original).input).toEqual([original.input[0]]);
  expect(original.input.length).toBe(2);
});

test("catalog updates preserve additions, removals, and changed descriptions, and are idempotent", () => {
  const first = catalog(`${a}\n${b}`);
  const second = catalog(a.replace("alpha description", "expanded alpha"));
  const third = catalog(
    `${a.replace("alpha description", "expanded alpha")}\n${b}`,
  );
  const normalized = normalizeContext(
    request([developer(first), developer(second), developer(third)]),
  );
  const text = JSON.stringify(normalized.input);
  expect(text.match(/<skills_instructions>/g)?.length).toBe(1);
  expect(text.match(/<skills_catalog_update>/g)?.length).toBe(2);
  expect(text).toContain("expanded alpha");
  expect(text).toContain("Removed entries:");
  expect(normalizeContext(normalized)).toEqual(normalized);
});

test("reassigned aliases do not reinterpret earlier entries", () => {
  const normalized = normalizeContext(
    request([
      developer(catalog(a)),
      developer(catalog(`${a}\n${b}`, "/new-skills")),
    ]),
  );
  expect(normalized.input[1].content).toContain(
    "(file: /new-skills/alpha/SKILL.md)",
  );
  expect(normalized.input[1].content).toContain("Removed entries:");
  expect(normalizeContext(normalized)).toEqual(normalized);
});

test("changed skill instructions and unknown formats pass through intact", () => {
  const unknown =
    "<skills_instructions>unrecognized catalog</skills_instructions>";
  const original = request([
    developer(catalog(a)),
    developer(catalog(a, "/skills", "New rule.")),
    developer(unknown),
    developer(catalog(a)),
  ]);
  expect(normalizeContext(original)).toBe(original);
});

test("server-side incremental requests are never rewritten", () => {
  const original = {
    ...request([developer(memory), developer(memory)]),
    previous_response_id: "resp_known",
  };
  expect(normalizeContext(original)).toBe(original);
});

test("mixed developer content preserves images and unrelated instructions", () => {
  const original = request([
    developer(memory),
    developer([
      { type: "input_text", text: memory + "\nOther rule." },
      { type: "input_image", image_url: "data:unchanged" },
    ]),
  ]);
  const result = normalizeContext(original);
  expect(result.input[1].content).toEqual([
    { type: "input_text", text: "\nOther rule." },
    { type: "input_image", image_url: "data:unchanged" },
  ]);
});

test("closing tag attached to the final entry does not silently drop that skill", () => {
  const first = catalog(`${a}\n${b}`);
  const sameInventory = first.replace(
    "\n</skills_instructions>",
    "</skills_instructions>",
  );
  const normalized = normalizeContext(
    request([developer(first), developer(sameInventory)]),
  );
  expect(normalized.input).toEqual([developer(first)]);
});

test("removals name the actual removed skill and locator", () => {
  const normalized = normalizeContext(
    request([developer(catalog(`${a}\n${b}`)), developer(catalog(a))]),
  );
  expect(normalized.input[1].content).toContain(
    "Removed entries:\n- beta (file: r0/beta/SKILL.md)",
  );
});

test("intervening developer instructions prevent suppression that would reverse precedence", () => {
  const repeated = request([
    developer(memory),
    developer("Use different instructions now."),
    developer(memory),
  ]);
  expect(normalizeContext(repeated)).toBe(repeated);
  const repeatedSkills = request([
    developer(catalog(a)),
    developer("Do not use alpha."),
    developer(catalog(a)),
  ]);
  expect(normalizeContext(repeatedSkills)).toBe(repeatedSkills);
});

test("memory and skill instructions remain separate precedence barriers", () => {
  const first = catalog(a, "/skills", "Follow different defaults.");
  for (const input of [
    [developer(memory), developer(first), developer(memory)],
    [developer(first), developer(memory), developer(first)],
    [
      developer(memory),
      developer(
        "<skills_instructions>Unknown overriding rule.</skills_instructions>",
      ),
      developer(memory),
    ],
  ]) {
    const original = request(input);
    expect(normalizeContext(original)).toBe(original);
  }
});
