/** Compact repeated context without rewriting earlier conversation prefixes. */
const BLOCKS =
  /<global-memory>[\s\S]*?<\/global-memory>|<skills_instructions>[\s\S]*?<\/skills_instructions>|<skills_catalog_update>[\s\S]*?<\/skills_catalog_update>/g;
const ENTRY = /^- (.+?): (.*?) \(file: (.+)\)$/;
const REMOVED = /^- (.+) \(file: (.+)\)$/;
const ROOT = /^- `(r\d+)` = `(.+)`$/;

function resolveLocator(locator, roots) {
  if (locator.startsWith("/")) return locator;
  const match = /^(r\d+)\/(.+)$/.exec(locator);
  return match && roots.has(match[1])
    ? `${roots.get(match[1])}/${match[2]}`
    : null;
}

function entry(line, roots) {
  const match = ENTRY.exec(line);
  if (!match) return null;
  const [, name, description, locator] = match;
  const path = resolveLocator(locator, roots);
  return path ? { name, description, locator, path } : null;
}
const key = (value) => JSON.stringify([value.name, value.path]);
const lineFor = (value) =>
  `- ${value.name}: ${value.description} (file: ${value.locator})`;

function catalog(block) {
  const lines = block
    .slice("<skills_instructions>".length, -"</skills_instructions>".length)
    .split("\n");
  const start = lines.indexOf("### Available skills");
  if (start < 0) return null;
  const roots = new Map();
  for (const line of lines.slice(0, start)) {
    const match = ROOT.exec(line);
    if (match) roots.set(match[1], match[2]);
  }
  const entries = new Map();
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const value = entry(line, roots);
    // Unknown catalog formats must retain their entire original context.
    if (!value || entries.has(key(value))) return null;
    entries.set(key(value), value);
  }
  if (!entries.size) return null;
  const policy = lines
    .slice(0, start)
    .filter((line) => !ROOT.test(line) && line !== "### Skill roots")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { roots, entries, policy };
}

function applyUpdate(block, current) {
  if (!current) return null;
  const entries = new Map(current.entries);
  let section;
  for (const line of block.split("\n").slice(2, -1)) {
    if (line === "Added or changed entries:") {
      section = "changed";
      continue;
    }
    if (line === "Removed entries:") {
      section = "removed";
      continue;
    }
    if (!line.trim()) continue;
    if (section === "changed") {
      const value = entry(line, current.roots);
      if (!value) return null;
      entries.set(key(value), value);
    } else if (section === "removed") {
      const match = REMOVED.exec(line);
      const path = match && resolveLocator(match[2], current.roots);
      if (!path) return null;
      entries.delete(key({ name: match[1], path }));
    } else return null;
  }
  return { ...current, entries };
}

/** Unknown formats, user quotes, tools, and server-side incremental histories
 * pass through. Only developer context in a supplied history is transformed. */
export function normalizeContext(request) {
  if (!request || request.previous_response_id || !Array.isArray(request.input))
    return request;
  let memory;
  let skills;
  let changed = false;
  const input = [];
  for (const item of request.input) {
    if (
      ["compaction", "compaction_summary", "context_compaction"].includes(
        item?.type,
      )
    ) {
      memory = undefined;
      skills = undefined;
    }
    if (
      !item ||
      item.role !== "developer" ||
      (item.type && item.type !== "message")
    ) {
      input.push(item);
      continue;
    }
    function compact(text) {
      let end = 0;
      function barrier(segment) {
        const remaining = segment.trim();
        // The timestamp hook carries no instruction override. Arbitrary
        // developer text may supersede prior rules, so keep later reassertions.
        if (remaining && !/^Current local time: [^\n]+$/.test(remaining)) {
          memory = undefined;
          skills = undefined;
        }
      }
      const result = text.replace(BLOCKS, (block, offset) => {
        barrier(text.slice(end, offset));
        end = offset + block.length;
        if (block.startsWith("<global-memory>")) {
          skills = undefined;
          const duplicate = memory === block;
          memory = block;
          return duplicate ? "" : block;
        }
        memory = undefined;
        if (block.startsWith("<skills_catalog_update>")) {
          skills = applyUpdate(block, skills);
          return block;
        }
        const next = catalog(block);
        if (!next || !skills || next.policy !== skills.policy) {
          skills = next;
          return block;
        }
        const added = [];
        const removed = [];
        const entries = new Map();
        for (const [id, value] of next.entries) {
          const previous = skills.entries.get(id);
          // Existing aliases belong to the first retained catalog. Resolve new
          // locations absolutely rather than redefining roots used by old entries.
          const retained = {
            ...value,
            locator: previous?.locator ?? value.path,
          };
          entries.set(id, retained);
          if (!previous || previous.description !== value.description)
            added.push(lineFor(retained));
        }
        for (const [id, value] of skills.entries) {
          if (!next.entries.has(id))
            removed.push(`- ${value.name} (file: ${value.locator})`);
        }
        skills = { ...skills, entries };
        if (!added.length && !removed.length) return "";
        return [
          "<skills_catalog_update>",
          "Keep earlier skills instructions and entries except for these catalog changes.",
          ...(added.length ? ["Added or changed entries:", ...added] : []),
          ...(removed.length ? ["Removed entries:", ...removed] : []),
          "</skills_catalog_update>",
        ].join("\n");
      });
      barrier(text.slice(end));
      return result;
    }
    if (typeof item.content === "string") {
      const content = compact(item.content);
      if (content === item.content) input.push(item);
      else {
        changed = true;
        if (content.trim()) input.push({ ...item, content });
      }
    } else if (Array.isArray(item.content)) {
      let itemChanged = false;
      const content = item.content.flatMap((part) => {
        if (
          !part ||
          !["input_text", "text"].includes(part.type) ||
          typeof part.text !== "string"
        ) {
          memory = undefined;
          skills = undefined;
          return [part];
        }
        const text = compact(part.text);
        if (text === part.text) return [part];
        itemChanged = true;
        return text.trim() ? [{ ...part, text }] : [];
      });
      if (!itemChanged) input.push(item);
      else {
        changed = true;
        if (content.length) input.push({ ...item, content });
      }
    } else input.push(item);
  }
  return changed ? { ...request, input } : request;
}
