export function isInteractiveAuthorizeRequest(requestUrl, issuer) {
  let request;
  let authorizationEndpoint;
  try {
    request = new URL(requestUrl);
    authorizationEndpoint = new URL(issuer);
    authorizationEndpoint.pathname = `${authorizationEndpoint.pathname.replace(/\/+$/, "")}/auth`;
    authorizationEndpoint.search = "";
    authorizationEndpoint.hash = "";
  } catch {
    return false;
  }

  return (
    request.origin === authorizationEndpoint.origin &&
    request.pathname === authorizationEndpoint.pathname &&
    request.searchParams.get("prompt") !== "none"
  );
}
