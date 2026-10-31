/** Decode the declared compact table in verifier fixtures; production uses server-owned entries. */
export function nativeEvidenceCatalog(payload: any): any[] {
  return payload.sources.map((row: any[]) => {
    const entry = Object.fromEntries(payload.sourceColumns.map((key: string, index: number) => [key, row[index]]));
    return { sourceId: entry.id, kind: entry.kind === 'cv' ? 'cv_original' : 'candidate_answer',
      quote: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
      ...(entry.kind === 'qa' ? { answerRecord: entry.content } : {}),
      position: entry.position && { block: entry.position[0], ordinal: entry.position[1], blockSize: entry.position[2] } };
  });
}
