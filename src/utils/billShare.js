import { formatCurrency, formatDate, splitGst } from './format.js';

const IMAGE_WIDTH = 1000;
const PADDING = 52;
const CONTENT_WIDTH = IMAGE_WIDTH - PADDING * 2;

function createBillCanvas(bill) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare the bill image on this device.');

  const rows = [];
  const pageBreaks = [];
  let y = PADDING;
  const setFont = (size, bold) => {
    context.font = `${bold ? '700' : '400'} ${size}px Arial, sans-serif`;
  };
  const addParagraph = (text, { size = 28, bold = false, align = 'left', gap = 12 } = {}) => {
    if (!text) return;
    setFont(size, bold);
    const words = String(text).split(/\s+/);
    let line = '';
    const lines = [];
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > CONTENT_WIDTH) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    for (const value of lines) {
      rows.push({ type: 'text', text: value, y, size, bold, align });
      y += size * 1.45;
    }
    y += gap;
  };
  const addRule = (dashed = false) => {
    rows.push({ type: 'rule', y, dashed });
    y += 24;
  };
  const addTotalsRow = (label, value, { bold = false, size = 28 } = {}) => {
    setFont(size, bold);
    const leftLines = [];
    let line = '';
    for (const word of String(label).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > CONTENT_WIDTH * 0.65) {
        leftLines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) leftLines.push(line);
    const rowHeight = Math.max(size * 1.45, leftLines.length * size * 1.35);
    rows.push({ type: 'total', leftLines, value: String(value), y, size, bold, rowHeight });
    y += rowHeight + 8;
  };

  addParagraph(bill.hotelName || 'BillNest', { size: 42, bold: true, align: 'center', gap: 4 });
  addParagraph(bill.hotelAddress, { size: 24, align: 'center', gap: 2 });
  if (bill.hotelPhone) addParagraph(`Phone: ${bill.hotelPhone}`, { size: 24, align: 'center', gap: 2 });
  if (bill.hotelGstin) addParagraph(`GSTIN: ${bill.hotelGstin}`, { size: 24, align: 'center', gap: 4 });
  addParagraph('TAX INVOICE', { size: 30, bold: true, align: 'center', gap: 8 });
  addRule();
  addParagraph(`Bill No: ${bill.bill_number || bill.billNumber || bill.id}`, { size: 26, bold: true, gap: 4 });
  if (bill.token) addParagraph(`Token: ${bill.token}  |  Payment: ${bill.payment_method || bill.paymentMethod || '—'}`, { size: 24, gap: 4 });
  if (bill.created_at || bill.createdAt) addParagraph(`Date: ${formatDate(bill.created_at || bill.createdAt)}`, { size: 24, gap: 4 });
  const customerName = bill.source === 'ROOM' ? bill.guestName : bill.customer_name || bill.customerName;
  const customerPhone = bill.source === 'ROOM' ? bill.guestPhone : bill.customerPhone || bill.customer_phone;
  if (customerName) addParagraph(`Customer: ${customerName}`, { size: 24, gap: 4 });
  if (customerPhone) addParagraph(`Phone: ${customerPhone}`, { size: 24, gap: 4 });
  if (bill.source === 'ROOM') {
    if (bill.roomNumber) addParagraph(`Room: ${bill.roomNumber}${bill.roomType ? ` (${bill.roomType})` : ''}`, { size: 24, gap: 4 });
    if (bill.booking_number || bill.bookingNumber) addParagraph(`Booking No: ${bill.booking_number || bill.bookingNumber}`, { size: 24, gap: 4 });
  }
  addRule();

  setFont(23, true);
  rows.push({ type: 'item-header', y, size: 23 });
  y += 38;
  for (const item of bill.items || []) {
    setFont(24, false);
    const name = String(item.name || 'Item');
    const words = name.split(/\s+/);
    const nameLines = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > 510) {
        nameLines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) nameLines.push(line);
    const rowHeight = Math.max(38, nameLines.length * 34);
    rows.push({
      type: 'item',
      y,
      rowHeight,
      nameLines,
      quantity: String(item.quantity ?? ''),
      price: formatCurrency(item.price),
      total: formatCurrency(item.total ?? (Number(item.price) * Number(item.quantity))),
    });
    y += rowHeight + 4;
    pageBreaks.push(y);
  }

  addRule();
  addTotalsRow('Subtotal', formatCurrency(bill.subtotal));
  const taxAmount = Number(bill.tax_amount ?? bill.taxAmount) || 0;
  if (taxAmount > 0) {
    const taxPercent = Number(bill.tax_percent ?? bill.taxPercent) || 0;
    const { halfPercent, cgstAmount, sgstAmount } = splitGst(taxPercent, taxAmount);
    addTotalsRow(`CGST (${halfPercent}%)`, formatCurrency(cgstAmount), { size: 25 });
    addTotalsRow(`SGST (${halfPercent}%)`, formatCurrency(sgstAmount), { size: 25 });
  }
  const discount = Number(bill.discount) || 0;
  if (discount > 0) addTotalsRow('Discount', `-${formatCurrency(discount)}`);
  addRule(true);
  addTotalsRow('TOTAL', formatCurrency(bill.total), { bold: true, size: 34 });
  if (Number(bill.advance_payment) > 0) {
    addTotalsRow('Advance Paid', formatCurrency(bill.advance_payment), { size: 25 });
    addTotalsRow('Balance Due', formatCurrency(bill.balance_due ?? bill.total), { bold: true, size: 27 });
  }
  addRule();
  addParagraph(bill.billFooter || 'Thank you! Visit again.', { size: 24, align: 'center', gap: 0 });

  canvas.width = IMAGE_WIDTH;
  canvas.height = Math.ceil(y + PADDING);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111827';
  ctx.strokeStyle = '#6b7280';
  ctx.lineWidth = 2;

  for (const row of rows) {
    if (row.type === 'rule') {
      ctx.setLineDash(row.dashed ? [8, 8] : []);
      ctx.beginPath();
      ctx.moveTo(PADDING, row.y);
      ctx.lineTo(IMAGE_WIDTH - PADDING, row.y);
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }
    setFontForContext(ctx, row.size, row.bold);
    if (row.type === 'text') {
      ctx.textAlign = row.align;
      const x = row.align === 'center' ? IMAGE_WIDTH / 2 : PADDING;
      ctx.fillText(row.text, x, row.y, CONTENT_WIDTH);
    } else if (row.type === 'item-header') {
      ctx.textAlign = 'left';
      ctx.fillText('Item', PADDING, row.y);
      ctx.textAlign = 'right';
      ctx.fillText('Qty', 650, row.y);
      ctx.fillText('Rate', 790, row.y);
      ctx.fillText('Amount', IMAGE_WIDTH - PADDING, row.y);
    } else if (row.type === 'item') {
      ctx.textAlign = 'left';
      row.nameLines.forEach((nameLine, index) => ctx.fillText(nameLine, PADDING, row.y + 27 + index * 34, 510));
      ctx.textAlign = 'right';
      ctx.fillText(row.quantity, 650, row.y + 27);
      ctx.fillText(row.price, 790, row.y + 27);
      ctx.fillText(row.total, IMAGE_WIDTH - PADDING, row.y + 27);
    } else if (row.type === 'total') {
      ctx.textAlign = 'left';
      row.leftLines.forEach((lineText, index) => ctx.fillText(lineText, PADDING, row.y + row.size + index * row.size * 1.35, CONTENT_WIDTH * 0.65));
      ctx.textAlign = 'right';
      ctx.fillText(row.value, IMAGE_WIDTH - PADDING, row.y + row.size, CONTENT_WIDTH * 0.32);
    }
  }
  return { canvas, pageBreaks };
}

function setFontForContext(context, size, bold = false) {
  context.font = `${bold ? '700' : '400'} ${size}px Arial, sans-serif`;
}

export function createBillShareMessage(bill, template) {
  const billNumber = bill.bill_number || bill.billNumber || bill.id;
  const hotelName = bill.hotelName || 'our business';
  const name = bill.source === 'ROOM' ? bill.guestName : bill.customer_name || bill.customerName;
  const messageTemplate = template || (name
    ? 'Hi {customer_name}, please find your bill {bill_number} from {business_name}. Total: {total}. Thank you!'
    : 'Hi, please find your bill {bill_number} from {business_name}. Total: {total}. Thank you!');
  const values = {
    customer_name: name || 'there',
    business_name: hotelName,
    bill_number: billNumber,
    total: formatCurrency(bill.total),
  };
  return String(messageTemplate).replace(/\{(\w+)\}/g, (_, key) => {
    return values[key] ?? '';
  });
}

function encodeText(value) {
  return new TextEncoder().encode(value);
}

async function canvasToJpegBytes(canvas) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('Could not prepare the bill PDF.'));
    }, 'image/jpeg', 0.94);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

async function createBillPdfBlob({ canvas: billCanvas, pageBreaks }) {
  const pageWidth = 595;
  const pageHeightPx = Math.floor(IMAGE_WIDTH * 842 / pageWidth);
  const pages = [];
  for (let sourceY = 0; sourceY < billCanvas.height;) {
    const maxEnd = Math.min(billCanvas.height, sourceY + pageHeightPx);
    const earliestPreferredEnd = sourceY + Math.floor(pageHeightPx * 0.65);
    const safeEnd = pageBreaks
      .filter((point) => point >= earliestPreferredEnd && point <= maxEnd)
      .at(-1);
    const end = maxEnd < billCanvas.height && safeEnd ? safeEnd : maxEnd;
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = IMAGE_WIDTH;
    pageCanvas.height = end - sourceY;
    const context = pageCanvas.getContext('2d');
    if (!context) throw new Error('Could not prepare a page for the bill PDF.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    context.drawImage(
      billCanvas,
      0, sourceY, IMAGE_WIDTH, pageCanvas.height,
      0, 0, IMAGE_WIDTH, pageCanvas.height,
    );
    pages.push({
      height: pageCanvas.height / IMAGE_WIDTH * pageWidth,
      image: await canvasToJpegBytes(pageCanvas),
    });
    sourceY = end;
  }

  const objects = [];
  const pageReferences = pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  objects.push([encodeText('<< /Type /Catalog /Pages 2 0 R >>')]);
  objects.push([encodeText(`<< /Type /Pages /Kids [${pageReferences}] /Count ${pages.length} >>`)]);
  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const pageHeight = page.height.toFixed(2);
    objects.push([encodeText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    )]);
    const content = encodeText(`q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`);
    objects.push([
      encodeText(`<< /Length ${content.length} >>\nstream\n`),
      content,
      encodeText('endstream'),
    ]);
    objects.push([
      encodeText(
        `<< /Type /XObject /Subtype /Image /Width ${IMAGE_WIDTH} /Height ${Math.round(page.height / pageWidth * IMAGE_WIDTH)} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.length} >>\nstream\n`,
      ),
      page.image,
      encodeText('\nendstream'),
    ]);
  });

  const chunks = [encodeText('%PDF-1.4\n')];
  const offsets = [0];
  let byteLength = chunks[0].length;
  objects.forEach((parts, index) => {
    offsets.push(byteLength);
    const objectChunks = [
      encodeText(`${index + 1} 0 obj\n`),
      ...parts,
      encodeText('\nendobj\n'),
    ];
    chunks.push(...objectChunks);
    byteLength += objectChunks.reduce((total, chunk) => total + chunk.length, 0);
  });
  const xrefOffset = byteLength;
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(encodeText(xref));
  return new Blob(chunks, { type: 'application/pdf' });
}

export async function createBillShareFile(bill) {
  const blob = await createBillPdfBlob(createBillCanvas(bill));
  const billNumber = bill.bill_number || bill.billNumber || bill.id;
  return new File([blob], `Bill-${billNumber}.pdf`, { type: 'application/pdf' });
}

export function canShareBillFromDevice() {
  if (typeof window === 'undefined') return false;
  const capacitor = window.Capacitor;
  if (
    typeof capacitor?.isNativePlatform === 'function'
    && capacitor.isNativePlatform()
    && typeof capacitor.Plugins?.MobileHost?.shareViaWhatsApp === 'function'
  ) return true;
  if (
    typeof navigator === 'undefined'
    || typeof navigator.share !== 'function'
    || typeof navigator.canShare !== 'function'
    || typeof File === 'undefined'
  ) {
    return false;
  }
  try {
    return navigator.canShare({ files: [new File([''], 'Bill.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
}

function encodeFileBase64(file) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
}

export async function shareBillFile(bill, customMessage) {
  const file = await createBillShareFile(bill);
  const message = customMessage || createBillShareMessage(bill);
  const capacitor = typeof window !== 'undefined' ? window.Capacitor : null;
  const plugin = capacitor?.isNativePlatform?.() ? capacitor.Plugins?.MobileHost : null;
  if (typeof plugin?.shareViaWhatsApp === 'function') {
    await plugin.shareViaWhatsApp({
      text: message,
      phoneNumber: bill.customerPhone || bill.customer_phone || bill.guestPhone || '',
      fileName: file.name,
      mimeType: file.type,
      fileBase64: await encodeFileBase64(file),
    });
    return;
  }
  if (
    typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [file] })
    && typeof navigator.share === 'function'
  ) {
    await navigator.share({
      files: [file],
      title: `Bill ${bill.bill_number || bill.billNumber || bill.id}`,
      text: message,
    });
    return;
  }
  throw new Error('This device cannot share a PDF bill. Open the app on Android or a mobile browser that supports file sharing.');
}
