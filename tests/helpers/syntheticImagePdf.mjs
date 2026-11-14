/** Build a minimal PDF with generated raster XObjects; no real candidate data. */
export function syntheticImagePdf(pages = []) {
  const objects = [];
  const push = (value) => {
    objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1'));
    return objects.length;
  };
  const catalogId = push('');
  const pagesId = push('');
  const pageIds = pages.map(() => push(''));
  const contentIds = pages.map(() => push(''));
  const imagesByKey = new Map();
  for (const page of pages) {
    for (const image of page || []) {
      if (!imagesByKey.has(image.key)) imagesByKey.set(image.key, image);
    }
  }
  const imageIds = new Map();
  for (const [key, image] of imagesByKey) {
    const stream = Buffer.from(image.bytes);
    const imageId = push(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]));
    imageIds.set(key, imageId);
  }
  objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  for (const [pageIndex, page] of pages.entries()) {
    const names = (page || []).map((image, index) => ({ name: `Im${index}`, id: imageIds.get(image.key) }));
    const resources = names.length
      ? `/Resources << /XObject << ${names.map(({ name, id }) => `/${name} ${id} 0 R`).join(' ')} >> >> `
      : '';
    const commands = names.map(({ name }) => `q 200 0 0 200 0 0 cm /${name} Do Q`).join('\n');
    const content = Buffer.from(commands, 'latin1');
    objects[pageIds[pageIndex] - 1] = Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ${resources}/Contents ${contentIds[pageIndex]} 0 R >>`);
    objects[contentIds[pageIndex] - 1] = Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from('\nendstream'),
    ]);
  }

  const chunks = [Buffer.from('%PDF-1.7\n')];
  const offsets = [0];
  let length = chunks[0].length;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length);
    const header = Buffer.from(`${index + 1} 0 obj\n`);
    const trailer = Buffer.from('\nendobj\n');
    chunks.push(header, objects[index], trailer);
    length += header.length + objects[index].length + trailer.length;
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  chunks.push(Buffer.from(xref), Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));
  return Buffer.concat(chunks);
}

export async function syntheticJpeg(width, height, color = '#6280aa') {
  const sharp = (await import('sharp')).default;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#e6c9a0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${Math.floor(width / 2)}" cy="${Math.floor(height / 2)}" r="${Math.floor(Math.min(width, height) / 5)}" fill="#ffffff" fill-opacity=".25"/></svg>`);
  const bytes = await sharp(svg).jpeg({ quality: 88 }).toBuffer();
  return { key: `${width}x${height}-${color}`, width, height, bytes };
}
