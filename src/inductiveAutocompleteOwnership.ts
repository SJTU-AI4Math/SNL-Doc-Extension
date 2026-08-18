export interface InductiveAutocompleteOwnershipMessage {
  ownerToken: string;
  ownsTab: boolean;
}

/** Apply one owner-token update without allowing stale releases to clear a newer owner. */
export function nextInductiveAutocompleteOwner(
  currentOwner: string | null,
  message: InductiveAutocompleteOwnershipMessage
): string | null {
  if (message.ownsTab) return message.ownerToken;
  return currentOwner === message.ownerToken ? null : currentOwner;
}
