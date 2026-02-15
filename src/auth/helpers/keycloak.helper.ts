export function keycloakConfig(
  url: string,
  realm: string,
): { jwksUri: string; issuer: string } {
  return {
    jwksUri: `${url}/realms/${realm}/protocol/openid-connect/certs`,
    issuer: `${url}/realms/${realm}`,
  }
}
