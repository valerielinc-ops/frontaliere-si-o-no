/** Create-only GCS writes with a generation tied to one operation ID and payload. */
import { createHash } from 'node:crypto';

export async function uploadOwnedArtifact({
  bucket, key, buffer, options = {}, writeId, acknowledged, recoverAcknowledgedWrite = true,
}) {
  const file = bucket.file(key);
  const contentSha256 = createHash('sha256').update(buffer).digest('hex');
  const uploadOptions = {
    ...options,
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      ...options.metadata,
      metadata: {
        ...options.metadata?.metadata,
        retentionWriteId: writeId,
        retentionContentSha256: contentSha256,
      },
    },
  };
  try {
    await file.save(buffer, uploadOptions);
  } catch (error) {
    if (!recoverAcknowledgedWrite) throw error;
    let metadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (readError) {
      if (Number(readError.code) === 404) throw error;
      throw readError;
    }
    const generation = ownedArtifactGeneration(metadata, writeId);
    if (!generation || metadata?.metadata?.retentionContentSha256 !== contentSha256) throw error;
    await acknowledged();
    return { file, generation };
  }
  await acknowledged();
  let metadata;
  try {
    [metadata] = await file.getMetadata();
  } catch (error) {
    if (Number(error.code) === 404) return null;
    throw error;
  }
  const generation = ownedArtifactGeneration(metadata, writeId);
  if (!generation) throw new Error('artifact_retention_generation_unknown');
  return { file, generation };
}

export function ownedArtifactGeneration(metadata, writeId) {
  return metadata?.metadata?.retentionWriteId === writeId && /^\d+$/.test(String(metadata.generation || ''))
    ? String(metadata.generation)
    : null;
}

export async function deleteOwnedArtifactGeneration(file, generation) {
  if (!/^\d+$/.test(String(generation || ''))) throw new Error('artifact_retention_generation_unknown');
  await file.delete({ ifGenerationMatch: String(generation), ignoreNotFound: true });
}
