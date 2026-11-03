export function validPublicIpv4(address: string): boolean;
export function validPathname(pathname: string): boolean;
export function resolvePublicIpv4(
  hostname: string,
  resolve?: (hostname: string, options: { all: true; family: 4; verbatim: true }) => Promise<Array<{ address: string; family: number }>>,
): Promise<string>;
export function validateRegistryRequest(
  path: string,
  hosts: ReadonlySet<string>,
): { hostname: string; upstreamPath: string; tarball: boolean } | null;
export function validateRedirectLocation(
  location: string,
  baseHost: string,
  hosts: ReadonlySet<string>,
): { hostname: string; pathname: string } | null;
export function validatePreviewRequest(
  requestTarget: string,
  host: string,
  expectedHost: string,
): { gamePath: string; query: string } | null;
export function registryAcceptHeader(pathname: string): string;
