export type KindDomain = 'entry' | 'macro';
type ExecuteCommand = (command: string, ...args: unknown[]) => PromiseLike<unknown>;

/** Validate and dispatch the closed edit-kind message route for a host panel. */
export async function handleEditKindMessage(
  message: unknown,
  domain: KindDomain,
  executeCommand: ExecuteCommand
): Promise<boolean> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  const expectedType = domain === 'entry' ? 'editEntryKind' : 'editMacroKind';
  if (record.type !== expectedType) return false;
  if (typeof record.id === 'string' && record.id.trim().length > 0) {
    await executeCommand(`snlDoc.${expectedType}`, record.id);
  }
  return true;
}
