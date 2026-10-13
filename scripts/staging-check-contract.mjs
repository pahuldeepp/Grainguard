export function assertAnonymousRequestRejected(response, service) {
  if (response.status !== 401)
    throw new Error(
      `${service} product API must reject anonymous requests with 401; received ${response.status}`,
    );
}
