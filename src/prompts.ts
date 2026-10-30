import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface JobPolicy {
  id: string;
  description: string;
  prompt: string;
}

export interface Prompts {
  persona: string | undefined;
  turnRules: string;
  planRules: string;
  cleanupRules: string | undefined;
  compactRules: string | undefined;
  jobPolicies: JobPolicy[];
}

export class PromptsError extends Error {}

const JOB_FILE_NAME = /^([a-z0-9][a-z0-9_-]*)\.md$/;

export function loadPrompts(promptsDir: string): Prompts {
  return {
    persona: readOptional(promptsDir, "persona.md"),
    turnRules: readRequired(promptsDir, "turn-rules.md"),
    planRules: readRequired(promptsDir, "plan-rules.md"),
    cleanupRules: readOptional(promptsDir, "cleanup-rules.md"),
    compactRules: readOptional(promptsDir, "compact-rules.md"),
    jobPolicies: loadJobPolicies(join(promptsDir, "jobs")),
  };
}

function readRequired(promptsDir: string, fileName: string): string {
  const content = readOptional(promptsDir, fileName);
  if (content === undefined) throw new PromptsError(`${join(promptsDir, fileName)}가 없다`);
  return content;
}

function readOptional(promptsDir: string, fileName: string): string | undefined {
  const path = join(promptsDir, fileName);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function loadJobPolicies(jobsDir: string): JobPolicy[] {
  const fileNames = existsSync(jobsDir)
    ? readdirSync(jobsDir).filter((name) => name.endsWith(".md"))
    : [];
  if (fileNames.length === 0) throw new PromptsError(`${jobsDir}에 방침 파일이 없다`);
  return fileNames
    .sort()
    .map((fileName) => parseJobPolicy(fileName, readFileSync(join(jobsDir, fileName), "utf8")));
}

function parseJobPolicy(fileName: string, text: string): JobPolicy {
  const id = JOB_FILE_NAME.exec(fileName)?.[1];
  if (id === undefined) {
    throw new PromptsError(`방침 파일명 ${fileName}은 소문자·숫자·-·_로 된 <id>.md여야 한다`);
  }
  const { fields, body } = splitFrontmatter(text);
  const description = fields.get("description");
  if (!description) throw new PromptsError(`방침 ${fileName}의 frontmatter에 description이 없다`);
  return { id, description, prompt: body };
}

function splitFrontmatter(text: string): { fields: Map<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { fields: new Map(), body: text.trim() };
  const [, header = "", body = ""] = match;
  const fields = new Map<string, string>();
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0)
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { fields, body: body.trim() };
}
