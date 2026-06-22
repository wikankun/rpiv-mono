import fs from "fs";
import path from "path";
import yaml from "yaml";
export function validate() {
    console.log("🔍 Validating rpiv-spec macros...");
    const specDir = path.resolve(process.cwd(), "../rpiv-spec");
    const agentsDir = path.join(specDir, "agents");
    const skillsDir = path.join(specDir, "skills");
    let hasErrors = false;
    const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".agent.yaml"));
    const agentIds = new Set(agentFiles.map((f) => yaml.parse(fs.readFileSync(path.join(agentsDir, f), "utf8")).id));
    const skillFiles = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".skill.yaml"));
    for (const file of skillFiles) {
        const spec = yaml.parse(fs.readFileSync(path.join(skillsDir, file), "utf8"));
        const body = fs.readFileSync(path.join(skillsDir, spec.body), "utf8");
        const matches = body.matchAll(/{{dispatch:([^}]+)}}/g);
        for (const match of matches) {
            const id = match[1];
            if (!agentIds.has(id)) {
                console.error(`❌ Skill "${spec.id}" dispatches unknown agent: ${id}`);
                hasErrors = true;
            }
        }
    }
    if (hasErrors) {
        process.exit(1);
    }
    else {
        console.log("✅ Macro validation passed.");
    }
}
