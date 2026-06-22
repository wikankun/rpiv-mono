import { Command } from "commander";
import { build } from "./build.js";
import { syncGuidance } from "./sync-guidance.js";
import { validate } from "./validate.js";
const program = new Command();
program.name("rpivc").description("RPIV Compiler CLI").version("1.19.1");
program
    .command("build")
    .description("Build RPIV spec for a target")
    .requiredOption("--target <target>", "Target platform (claude-code, omp, opencode, gemini, codex, pi)")
    .requiredOption("--out <dir>", "Output directory")
    .action((options) => {
    build(options.target, options.out);
});
program
    .command("sync-guidance")
    .description("Sync guidance files to a target file")
    .requiredOption("--target <dir>", "Built target directory")
    .requiredOption("--guidance-file <file>", "Guidance file to update (e.g., CLAUDE.md)")
    .action((options) => {
    syncGuidance(options.target, options.guidanceFile);
});
program
    .command("validate")
    .description("Validate RPIV spec")
    .action(() => {
    validate();
});
program.parse();
