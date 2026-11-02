export function validPublicIpv4(address: string): boolean;
export function validPathname(pathname: string): boolean;
export function validateRegistryRequest(
  path: string,
  hosts: ReadonlySet<string>,
): { hostname: string; upstreamPath: string; tarball: boolean } | null;
export function validateRedirectLocation(
  location: string,
  baseHost: string,
  hosts: ReadonlySet<string>,
): { hostname: string; pathname: string } | null;
