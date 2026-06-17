import Ajv from "ajv";
import fs from "fs";
import path from "path";
import yaml from "yaml";

const ajv = new Ajv();

const skillSchema = JSON.parse(fs.readFileSync("schema/skill.schema.json", "utf8"));
const agentSchema = JSON.parse(fs.readFileSync("schema/agent.schema.json", "utf8"));

const validateSkill = ajv.compile(skillSchema);
const validateAgent = ajv.compile(agentSchema);

let hasErrors = false;

// 1. Validate agents
const agents = fs.readdirSync("agents").filter((f) => f.endsWith(".agent.yaml"));
const agentIds = new Set();

for (const file of agents) {
	const content = yaml.parse(fs.readFileSync(path.join("agents", file), "utf8"));
	if (!validateAgent(content)) {
		console.error(`❌ Agent validation failed: agents/${file}`);
		console.error(validateAgent.errors);
		hasErrors = true;
	}
	agentIds.add(content.id);

	// Check body exists
	const bodyPath = path.join("agents", content.prompt);
	if (!fs.existsSync(bodyPath)) {
		console.error(`❌ Agent prompt file missing: ${bodyPath}`);
		hasErrors = true;
	}
}

// 2. Validate skills
const skills = fs.readdirSync("skills").filter((f) => f.endsWith(".skill.yaml"));

for (const file of skills) {
	const content = yaml.parse(fs.readFileSync(path.join("skills", file), "utf8"));
	if (!validateSkill(content)) {
		console.error(`❌ Skill validation failed: skills/${file}`);
		console.error(validateSkill.errors);
		hasErrors = true;
	}

	// Check body exists
	const bodyPath = path.join("skills", content.body);
	if (!fs.existsSync(bodyPath)) {
		console.error(`❌ Skill body file missing: ${bodyPath}`);
		hasErrors = true;
	} else {
		// Check dispatches resolve
		const bodyContent = fs.readFileSync(bodyPath, "utf8");
		const matches = bodyContent.matchAll(/{{dispatch:([^}]+)}}/g);
		for (const match of matches) {
			const targetId = match[1];
			if (!agentIds.has(targetId)) {
				console.error(`❌ Skill ${content.id} dispatches unknown agent: ${targetId}`);
				hasErrors = true;
			}
		}
	}
}

if (hasErrors) {
	process.exit(1);
} else {
	console.log("✅ rpiv-spec validation passed.");
}
