/** Reserved ASCII names stay excluded on both case-sensitive and insensitive volumes. */
export function isLocalReservedName(name: string): boolean {
  const folded = name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return (
    folded === '.git' ||
    folded === '.agora-operations' ||
    folded === '.env' ||
    folded.startsWith('.env.')
  );
}
