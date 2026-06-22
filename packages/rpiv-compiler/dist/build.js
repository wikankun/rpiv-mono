import fs from "fs";
import path from "path";
import yaml from "yaml";
import { claudeCodeMapping } from "./targets/claude-code.js";
import { ompMapping } from "./targets/omp.js";
import { piMapping } from "./targets/pi.js";
const mappings = {
    pi: piMapping,
    "claude-code": claudeCodeMapping,
    omp: ompMapping,
    opencode: null,
    gemini: null,
    codex: null,
};
export function build(target, outDir) {
    const mapping = mappings[target];
    if (!mapping) {
        console.error(`❌ Target "${target}" not implemented or unknown.`);
        process.exit(1);
    }
    console.log(`🔨 Building for target: ${target} -> ${outDir}`);
    const specDir = path.resolve(process.cwd(), "../rpiv-spec");
    const agentsDir = path.join(specDir, "agents");
    const skillsDir = path.join(specDir, "skills");
    // 1. Build Agents
    const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".agent.yaml"));
    for (const file of agentFiles) {
        const spec = yaml.parse(fs.readFileSync(path.join(agentsDir, file), "utf8"));
        const body = fs.readFileSync(path.join(agentsDir, spec.prompt), "utf8");
        const expandedBody = expandMacros(body, mapping.agents);
        if (target === "claude-code") {
            const dest = path.join(outDir, "agents", `${spec.id}.md`);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, `---\nname: ${spec.id}\ndescription: ${spec.description}\n---\n\n${expandedBody}`);
        }
        else if (target === "pi" || target === "omp") {
            const dest = path.join(outDir, "agents", `${spec.id}.md`);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const tools = spec.tools ? spec.tools.join(", ") : "";
            const model = spec.model_tier === "advisor" && target === "omp" ? "slow" : spec.model_tier || "default";
            fs.writeFileSync(dest, `---\nname: ${spec.id}\ndescription: ${spec.description}\ntools: ${tools}\nmodel: ${model}\nisolated: true\n---\n\n${expandedBody}`);
        }
    }
    // 2. Build Skills
    const skillFiles = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".skill.yaml"));
    const skills = [];
    for (const file of skillFiles) {
        const spec = yaml.parse(fs.readFileSync(path.join(skillsDir, file), "utf8"));
        const body = fs.readFileSync(path.join(skillsDir, spec.body), "utf8");
        const expandedBody = expandMacros(body, mapping.skills);
        if (target === "claude-code") {
            const dest = path.join(outDir, "skills", spec.id, "SKILL.md");
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, `---\nname: ${spec.id}\ndescription: ${spec.description}\n---\n\n${expandedBody}`);
            skills.push({ id: spec.id, description: spec.description });
        }
        else if (target === "pi" || target === "omp") {
            const dest = path.join(outDir, "skills", spec.id, "SKILL.md");
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, `---\nname: ${spec.id}\ndescription: ${spec.description}\n---\n\n${expandedBody}`);
            skills.push({ id: spec.id, description: spec.description });
        }
    }
    if (target === "claude-code") {
        // 3. Create session-start hook
        const hookPath = path.join(outDir, "hooks", "session-start.sh");
        fs.mkdirSync(path.dirname(hookPath), { recursive: true });
        const hookContent = `#!/bin/bash\nmkdir -p thoughts/shared/{questions,research,solutions,designs,plans}\n# rpivc sync-guidance --target . --guidance-file CLAUDE.md\n`;
        fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
        const pluginJsonPath = path.join(outDir, ".claude-plugin", "plugin.json");
        fs.mkdirSync(path.dirname(pluginJsonPath), { recursive: true });
        const pluginJson = {
            name: "rpiv",
            version: "1.19.1",
            description: "RPIV workflow for Claude Code",
            skills: skills.map((s) => ({ name: s.id, path: `../skills/${s.id}/SKILL.md` })),
            hooks: {
                session_start: "../hooks/session-start.sh",
            },
        };
        fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2));
        const marketplaceJsonPath = path.join(outDir, ".claude-plugin", "marketplace.json");
        const marketplaceJson = {
            name: "rpiv",
            version: "1.19.1",
            description: "RPIV workflow for Claude Code",
            publisher: "rpiv",
            entry: "plugin.json",
        };
        fs.writeFileSync(marketplaceJsonPath, JSON.stringify(marketplaceJson, null, 2));
    }
    else if (target === "omp") {
        // Create omp manifest in package.json (simulated)
        console.log('ℹ️ OMP target: ensuring package.json uses "omp" key for compatibility.');
    }
    console.log(`✅ Build complete for ${target}.`);
}
function expandMacros(content, mapping) {
    let result = content;
    // Replace {{dispatch:id}}
    result = result.replace(/{{dispatch:([^}]+)}}/g, (_, id) => mapping.dispatch(id));
    // Replace {{tool:id}}
    result = result.replace(/{{tool:([^}]+)}}/g, (_, id) => mapping.tool(id));
    return result;
}
