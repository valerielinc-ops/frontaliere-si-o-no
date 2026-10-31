/** Explicit Firestore/GCS I/O fixture; production admission and publication code stays real. */
export function materialCopyFixture({ now = Date.now() } = {}) {
  let clock = now, sequence = 1, queue = Promise.resolve();
  const documents = new Map(), objects = new Map(), deleted = [], writes = [];
  const hooks = { beforeSave: null, afterSave: null, beforeDownload: null, afterCommit: null, beforeCommit: null };
  const clone = value => {
    if (value == null || typeof value !== 'object') return value;
    if (typeof value.toMillis === 'function') return value; // Real immutable SDK Timestamp, not structuredClone's plain imitation.
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(clone);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  };
  const apply = (path, patch, merge) => {
    const current = merge ? { ...documents.get(path) } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value?.constructor?.name === 'NumericIncrementTransform' || value?.__increment !== undefined) current[key] = Number(current[key] || 0) + Number(value.operand ?? value.__increment);
      else if (value?.constructor?.name === 'ServerTimestampTransform') current[key] = new Date(clock);
      else if (value?.constructor?.name === 'DeleteTransform') delete current[key];
      else current[key] = clone(value);
    }
    documents.set(path, current);
  };
  function ref(path) {
    const result = { path, id: path.split('/').at(-1),
      async get() { const value = documents.get(path); return { id: result.id, ref: result, exists: value !== undefined, data: () => clone(value) }; },
      async set(data, options) { apply(path, data, options?.merge); },
      async delete() { documents.delete(path); },
      collection: name => collection(`${path}/${name}`),
    };
    return result;
  }
  function query(paths, filters = [], limit = Infinity, after = '') {
    return {
      where: (field, operator, value) => query(paths, [...filters, [field, operator, value]], limit, after),
      orderBy: () => query(paths, filters, limit, after),
      limit: value => query(paths, filters, value, after),
      startAfter: value => query(paths, filters, limit, typeof value === 'string' ? value : value.ref.path),
      async get() {
        const keys = paths().filter(path => path > after && filters.every(([field, operator, value]) => {
          if (operator !== '==') throw new Error('fixture_query_operator_missing');
          return documents.get(path)?.[field] === value;
        })).sort().slice(0, limit);
        return { docs: await Promise.all(keys.map(path => ref(path).get())) };
      },
    };
  }
  function collection(path) {
    return { ...query(() => [...documents.keys()].filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)),
      doc: id => ref(`${path}/${id || `fixture-${++sequence}`}`) };
  }
  const db = { collection, collectionGroup: name => query(() => [...documents.keys()].filter(key => key.split('/').at(-2) === name)),
    runTransaction(callback) {
      const result = queue.then(async () => {
        const operations = [];
        const tx = { get: target => target.get(), set: (target, data, options) => operations.push(() => apply(target.path, data, options?.merge)),
          delete: target => operations.push(() => documents.delete(target.path)) };
        const value = await callback(tx);
        await hooks.beforeCommit?.({ operations, documents });
        operations.forEach(operation => operation());
        await hooks.afterCommit?.({ operations, documents });
        return value;
      });
      queue = result.catch(() => {}); return result;
    },
  };
  const bucket = { file(key, options = {}) {
    return { key, path: key,
      async exists() { return [objects.has(key)]; },
      async getMetadata() {
        const object = objects.get(key);
        if (!object || options.generation && options.generation !== object.generation) throw Object.assign(new Error('missing'), { code: 404 });
        return [{ size: String(object.bytes.length), generation: object.generation, contentType: object.contentType,
          metadata: { ...object.metadata } }];
      },
      async download(range = {}) {
        await hooks.beforeDownload?.({ key, options, range, documents, objects });
        const object = objects.get(key);
        if (!object || options.generation && options.generation !== object.generation) throw Object.assign(new Error('missing'), { code: 404 });
        if (!options.generation) throw new Error('fixture_source_generation_not_pinned');
        return [Buffer.from(object.bytes).subarray(range.start || 0, range.end == null ? undefined : range.end + 1)];
      },
      async save(bytes, saveOptions) {
        if (saveOptions.preconditionOpts?.ifGenerationMatch !== 0) throw new Error('fixture_create_only_missing');
        await hooks.beforeSave?.({ key, documents, objects });
        if (objects.has(key)) throw Object.assign(new Error('exists'), { code: 412 });
        objects.set(key, { bytes: Buffer.from(bytes), generation: String(++sequence), contentType: saveOptions.contentType,
          metadata: { ...saveOptions.metadata?.metadata } });
        writes.push(key);
        await hooks.afterSave?.({ key, options: saveOptions, documents, objects });
      },
      async delete(deleteOptions) {
        const object = objects.get(key);
        if (object && deleteOptions?.ifGenerationMatch !== object.generation) throw Object.assign(new Error('different generation'), { code: 412 });
        objects.delete(key); deleted.push(key);
      },
    };
  } };
  const sourceKey = 'application-concierge-uploads/service/cv.pdf';
  const service = { userId: 'candidate', paymentStatus: 'paid', serviceStatus: 'active', expiresAt: new Date(now + 86400000),
    cvStorageKey: sourceKey, cvUploadedAt: new Date(now - 1000), consentVersion: 'application-concierge-v1', consentedAt: new Date(now - 1000), acceptedPositionsCount: 0 };
  const proposal = { status: 'proposed', eligibilityStatus: 'compatible', eligibilityCvStorageKey: sourceKey,
    jobId: 'job', jobUrl: 'https://example.test/job', companyId: 'example', companyName: 'Example', jobTitle: 'Example role' };
  documents.set('application_concierge_services/service', clone(service));
  documents.set('application_concierge_services/service/proposals/proposal', clone(proposal));
  objects.set(sourceKey, { bytes: Buffer.from('%PDF-synthetic CV'), generation: '1', contentType: 'application/pdf', metadata: {} });
  return { db, bucket, documents, objects, deleted, writes, hooks, service, proposal, sourceKey, now,
    get clock() { return clock; }, set clock(value) { clock = value; }, clone, ref,
    records: () => [...documents].filter(([path]) => path.includes('/pending_material_copies/')),
  };
}
