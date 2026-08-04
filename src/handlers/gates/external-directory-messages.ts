import {
  type ExternalPathDisclosure,
  resolvesToSuffix,
} from "#src/denial-messages";
import { keyValueBlock } from "#src/permission-prompts";

export function formatExternalDirectoryAskPrompt(
  toolName: string,
  pathValue: string,
  resolvedPath: string | undefined,
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return keyValueBlock([
    ["Agent", subject],
    ["Tool", toolName],
    ["Path", `${pathValue}${resolvesToSuffix(resolvedPath)}`],
    ["CWD", cwd],
  ]);
}

export function formatBashExternalDirectoryAskPrompt(
  command: string,
  externalPaths: ExternalPathDisclosure[],
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  const rows: Array<[string, string]> = [
    ["Agent", subject],
    ["Rule", `references path(s) outside working directory '${cwd}'`],
  ];
  for (const { path, resolvedPath } of externalPaths) {
    rows.push(["Path", `${path}${resolvesToSuffix(resolvedPath)}`]);
  }
  return `${keyValueBlock(rows)}\n\n$ ${command}`;
}
