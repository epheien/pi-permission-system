import {
  type ExternalPathDisclosure,
  resolvesToSuffix,
} from "#src/denial-messages";

export function formatExternalDirectoryAskPrompt(
  toolName: string,
  pathValue: string,
  resolvedPath: string | undefined,
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested tool '${toolName}' for path '${pathValue}'${resolvesToSuffix(resolvedPath)} outside working directory '${cwd}'. Allow this external directory access?`;
}

export function formatBashExternalDirectoryAskPrompt(
  command: string,
  externalPaths: ExternalPathDisclosure[],
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  const pathList = externalPaths
    .map(({ path, resolvedPath }) => `${path}${resolvesToSuffix(resolvedPath)}`)
    .join(", ");
  return `${subject} requested bash command '${command}' which references path(s) outside working directory '${cwd}': ${pathList}. Allow this external directory access?`;
}
