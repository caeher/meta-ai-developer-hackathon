export function getNodeVersionError(version) {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);

  if (major !== 24) {
    return `Node.js 24.x is required (received ${version || "unknown"}).`;
  }

  return undefined;
}

const error = getNodeVersionError(process.versions.node);

if (error) {
  console.error(error);
  process.exitCode = 1;
}
