import {
  assertNever,
  type AnyProviderAdapter,
  type FetchLike,
  type ProviderAdapter,
} from "./adapter.js";
import {
  createRotationFetch,
  type RotationManager,
} from "./rotation-fetch.js";

function isLegacyHttpAdapter(
  adapter: AnyProviderAdapter,
): adapter is ProviderAdapter {
  return !("transport" in adapter);
}

export function createProviderFetch(
  adapter: AnyProviderAdapter,
  manager: RotationManager | unknown,
): FetchLike {
  if (isLegacyHttpAdapter(adapter)) {
    return createRotationFetch(adapter, manager as RotationManager);
  }

  switch (adapter.transport.kind) {
    case "http":
      return createRotationFetch(
        adapter,
        adapter.transport,
        manager as RotationManager,
      );
    case "custom":
      return adapter.transport.createFetch({
        descriptor: adapter,
        manager,
      });
    default:
      return assertNever(adapter.transport);
  }
}
