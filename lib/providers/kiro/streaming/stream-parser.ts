export function findRealTag(buffer: string, tag: string): number {
  const codeBlockPattern = /```[\s\S]*?```/g;
  const codeBlocks: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockPattern.exec(buffer)) !== null) {
    codeBlocks.push([match.index, match.index + match[0].length]);
  }

  let position = 0;
  while ((position = buffer.indexOf(tag, position)) !== -1) {
    let inCodeBlock = false;
    for (const [start, end] of codeBlocks) {
      if (position >= start && position < end) {
        inCodeBlock = true;
        break;
      }
    }
    if (!inCodeBlock) return position;
    position += tag.length;
  }
  return -1;
}
