import fs from "fs";
import path from "path";

export function syncGuidance(_targetDir: string, guidanceFile: string) {
	console.log(`🔄 Syncing guidance to ${guidanceFile}...`);

	const guidanceSourceDir = path.resolve(process.cwd(), "../rpiv-pi/.rpiv/guidance");

	if (!fs.existsSync(guidanceSourceDir)) {
		console.warn(`⚠️ Guidance source directory not found: ${guidanceSourceDir}`);
		return;
	}

	const guidanceFiles = fs.readdirSync(guidanceSourceDir).filter((f) => f.endsWith(".md"));

	if (guidanceFiles.length === 0) {
		console.log("ℹ️ No guidance files to sync.");
		return;
	}

	let guidanceContent = "";
	for (const file of guidanceFiles) {
		const content = fs.readFileSync(path.join(guidanceSourceDir, file), "utf8");
		guidanceContent += `\n### ${file}\n\n${content}\n`;
	}

	const targetPath = path.resolve(process.cwd(), guidanceFile);
	let fileContent = "";
	if (fs.existsSync(targetPath)) {
		fileContent = fs.readFileSync(targetPath, "utf8");
	}

	const markerStart = "<!-- BEGIN RPIV GUIDANCE -->";
	const markerEnd = "<!-- END RPIV GUIDANCE -->";
	const newBlock = `${markerStart}\n${guidanceContent}\n${markerEnd}`;

	const regex = new RegExp(`${markerStart}[\\s\\S]*${markerEnd}`, "g");

	if (fileContent.includes(markerStart)) {
		fileContent = fileContent.replace(regex, newBlock);
	} else {
		fileContent += `\n\n${newBlock}\n`;
	}

	fs.writeFileSync(targetPath, fileContent);
	console.log(`✅ Guidance synced to ${guidanceFile}.`);
}
