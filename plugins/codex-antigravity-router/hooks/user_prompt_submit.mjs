import fs from "node:fs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

try {
  const event = JSON.parse(raw);
  const prompt = typeof event.prompt === "string" ? event.prompt : "";
  const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
  const projectLike = [".git", "pyproject.toml", "package.json", "Cargo.toml", "*.uproject"]
    .some((name) => {
      let directory = cwd;
      for (let depth = 0; depth < 5; depth++) {
        try {
          if (name === "*.uproject" && fs.readdirSync(directory).some((file) => file.endsWith(".uproject"))) return true;
          if (name !== "*.uproject" && fs.existsSync(`${directory}/${name}`)) return true;
        } catch {}
        const parent = directory.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
        if (!parent || parent === directory) break;
        directory = parent;
      }
      return false;
    });

  if (projectLike && !/\b(?:do not|don't|never)\s+(?:use|call|delegate to)\s+antigravity\b/i.test(prompt)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "For suitable engineering work, use the antigravity-delegation skill. Delegate coherent LOW_RISK or HIGH_RISK outcomes when it saves Codex effort; keep briefs concise and quality constraints explicit. Trust independent verification for LOW_RISK; review HIGH_RISK only when warranted. Honor any user instruction against Antigravity."
      }
    }));
  }
} catch (error) {
  // Hook failures must not interrupt normal Codex work.
  process.stderr.write(`Antigravity router prompt hook skipped: ${error.message}\n`);
}
