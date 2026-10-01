import { describe, expect, test } from "bun:test";
import { normalizeVisualizeReferences } from "../src/visualize";

const wrapped = (json: string) => `visualize${json}`;
const reference = '{"path":"/tmp/viz/next-carousel.html","title":"Next card carousel"}';

describe("visualize content references", () => {
  test("wraps a bare reference line in the delimiters Codex Desktop parses", () => {
    const text = `Here it is.\n\nvisualize${reference}\n\nOne note.`;
    expect(normalizeVisualizeReferences(text)).toBe(`Here it is.\n\n${wrapped(reference)}\n\nOne note.`);
  });

  test("keeps wide mode and trailing whitespace-only lines intact", () => {
    const wide = '{"path":"/tmp/viz/app.html","mode":"wide"}';
    expect(normalizeVisualizeReferences(`visualize${wide}  `)).toBe(wrapped(wide));
    expect(normalizeVisualizeReferences(`visualize${wide}\r\nnext`)).toBe(`${wrapped(wide)}\r\nnext`);
  });

  test("leaves already wrapped references unchanged", () => {
    const text = `Intro\n${wrapped(reference)}`;
    expect(normalizeVisualizeReferences(text)).toBe(text);
  });

  test("leaves references inside code fences, prose, and invalid JSON alone", () => {
    for (const text of [
      `\`\`\`text\nvisualize${reference}\n\`\`\``,
      `~~~~\nvisualize${reference}\n~~~\nvisualize${reference}\n~~~~`,
      `Use visualize${reference} on its own line.`,
      "visualize{not json}",
      'visualize{"title":"no path"}',
      `    visualize${reference}`,
    ]) expect(normalizeVisualizeReferences(text)).toBe(text);
  });

  test("resumes rewriting after a closed fence", () => {
    const text = `\`\`\`\nvisualize${reference}\n\`\`\`\nvisualize${reference}`;
    expect(normalizeVisualizeReferences(text)).toBe(`\`\`\`\nvisualize${reference}\n\`\`\`\n${wrapped(reference)}`);
  });
});
