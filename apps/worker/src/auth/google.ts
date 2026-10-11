// Google OpenID Connect with oauth4webapi. See "Site sign-in" and Q5 in
// plans/haystack-v1-implementation-plan.md. Every endpoint comes from configuration, so tests
// point them at a fixture server and no discovery request is made.
import * as oauth from "oauth4webapi";

export interface GoogleConfig {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_ISSUER: string;
  GOOGLE_AUTHORIZATION_ENDPOINT: string;
  GOOGLE_TOKEN_ENDPOINT: string;
  GOOGLE_JWKS_URI: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function authorizationServer(config: GoogleConfig): oauth.AuthorizationServer {
  return {
    issuer: config.GOOGLE_ISSUER,
    authorization_endpoint: config.GOOGLE_AUTHORIZATION_ENDPOINT,
    token_endpoint: config.GOOGLE_TOKEN_ENDPOINT,
    jwks_uri: config.GOOGLE_JWKS_URI,
  };
}

// oauth4webapi refuses http: endpoints. The tests' fixture server is http: on a loopback host,
// so only that case is allowed. Any other http: endpoint still fails in oauth4webapi. The option
// is marked deprecated "to make it stand out"; its documented use is testing against non-TLS servers.
/** True only when every http: endpoint the Worker fetches is on a loopback host. */
export function allowsInsecureRequests(config: GoogleConfig): boolean {
  const endpoints = [config.GOOGLE_TOKEN_ENDPOINT, config.GOOGLE_JWKS_URI].map(
    (value) => new URL(value),
  );
  const usesHttp = endpoints.some((url) => url.protocol === "http:");
  const httpOnlyOnLoopback = endpoints.every(
    (url) => url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname),
  );
  return usesHttp && httpOnlyOnLoopback;
}

function requestOptions(config: GoogleConfig): { [oauth.allowInsecureRequests]?: boolean } {
  return allowsInsecureRequests(config) ? { [oauth.allowInsecureRequests]: true } : {};
}

/** The URL that starts sign-in at Google. */
export function authorizationUrl(
  config: GoogleConfig,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(config.GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/**
 * Completes the authorization code flow: validates the callback against the expected state,
 * exchanges the code with the PKCE verifier, validates the ID token's claims (issuer, audience,
 * expiry) and its signature against Google's keys. Returns the identity only for a verified
 * email. Throws when any step fails.
 */
export async function completeSignIn(
  config: GoogleConfig,
  callbackUrl: URL,
  expectedState: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<GoogleIdentity> {
  const as = authorizationServer(config);
  const client: oauth.Client = { client_id: config.GOOGLE_CLIENT_ID };
  const options = requestOptions(config);
  const parameters = oauth.validateAuthResponse(as, client, callbackUrl, expectedState);
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    oauth.ClientSecretPost(config.GOOGLE_CLIENT_SECRET),
    parameters,
    redirectUri,
    codeVerifier,
    options,
  );
  const result = await oauth.processAuthorizationCodeResponse(as, client, response, {
    requireIdToken: true,
  });
  // processAuthorizationCodeResponse checks the claims but relies on TLS for the token's origin.
  // The plan requires verifying the signature too.
  await oauth.validateApplicationLevelSignature(as, response, options);
  const claims = oauth.getValidatedIdTokenClaims(result);
  if (claims === undefined || claims.email_verified !== true || typeof claims.email !== "string") {
    throw new Error("The ID token has no verified email");
  }
  return { sub: claims.sub, email: claims.email };
}
